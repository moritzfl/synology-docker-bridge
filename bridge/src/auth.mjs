import crypto from "node:crypto";

/**
 * Bridge sessions. The package CGI authenticates the DSM user, checks the app privilege and asks
 * the bridge for a one-time login token. The browser exchanges that token for an HttpOnly cookie.
 * Sessions end after {@code sessionSeconds} without a request, or when the bridge restarts; the
 * DSM window then re-mints one silently because the user is still signed in to DSM.
 *
 * A session is also only trusted for {@code verifySeconds} after the privilege was last checked.
 * The window re-checks in the background and renews it with another one-time token, so a user
 * whose access was revoked is shut out within that time, not only after idling.
 * The bridge never calls DSM itself, so DSM session/IP binding does not matter.
 */
export function createAuthenticator(config) {
  const oneTime = new Map();
  const sessions = new Map();
  const oneTimeMs = Math.max(10, config.oneTimeSeconds) * 1000;
  const sessionMs = Math.max(60, config.sessionSeconds) * 1000;
  const verifyMs = Math.max(60, config.verifySeconds || 1800) * 1000;
  const cookieName = config.sessionCookie || "dsm_bridge_session";

  function prune() {
    const now = Date.now();
    for (const [key, value] of oneTime) {
      if (value.expiresAt <= now) oneTime.delete(key);
    }
    for (const [key, value] of sessions) {
      if (value.expiresAt <= now || value.verifiedUntil <= now) {
        closeSockets(value);
        sessions.delete(key);
      }
    }
  }

  /** Ends the open WebSockets of a session; they authenticated only when they were opened. */
  function closeSockets(entry) {
    for (const close of entry.sockets) {
      close();
    }
    entry.sockets.clear();
  }

  function take(token) {
    prune();
    const entry = oneTime.get(token);
    oneTime.delete(token);
    return entry && entry.expiresAt > Date.now() ? entry : null;
  }

  /** The live session among the request's cookies, or null. */
  function find(request) {
    // Earlier versions set the cookie on Path=/, shared by every package; such a stale cookie
    // may arrive next to this package's own, so accept any value that is a live session.
    const now = Date.now();
    for (const value of cookieValues(request.headers.cookie, cookieName)) {
      const entry = sessions.get(value);
      if (!entry) {
        continue;
      }
      if (entry.expiresAt <= now || entry.verifiedUntil <= now) {
        closeSockets(entry);
        sessions.delete(value);
        continue;
      }
      entry.key = value;
      return entry;
    }
    return null;
  }

  return {
    mint(identity) {
      prune();
      const {
        user = "",
        groups = [],
        name = "",
        email = "",
      } = typeof identity === "string" ? { user: identity } : identity || {};
      const token = crypto.randomBytes(24).toString("base64url");
      oneTime.set(token, {
        user: String(user),
        groups: Array.isArray(groups) ? groups.map(String) : [],
        name: String(name || ""),
        email: String(email || ""),
        expiresAt: Date.now() + oneTimeMs,
      });
      return token;
    },

    login(token) {
      const entry = take(token);
      if (!entry) {
        return null;
      }
      const session = crypto.randomBytes(32).toString("base64url");
      const now = Date.now();
      sessions.set(session, {
        user: entry.user,
        groups: entry.groups,
        name: entry.name,
        email: entry.email,
        expiresAt: now + sessionMs,
        verifiedUntil: now + verifyMs,
        sockets: new Set(),
      });
      return session;
    },

    /** Registers how to end a WebSocket of the session; returns a function that removes it again. */
    track(key, close) {
      if (!key) {
        return () => {};
      }
      const entry = sessions.get(key);
      if (!entry) {
        close();
        return () => {};
      }
      entry.sockets.add(close);
      return () => entry.sockets.delete(close);
    },

    /** Ends sessions whose last privilege check or activity is too old, and their sockets. */
    sweep() {
      prune();
    },

    /** Renews the request's session with a fresh one-time token for the same user. */
    refresh(request, token) {
      const entry = take(token);
      const session = entry && find(request);
      if (!session || session.user !== entry.user) {
        return false;
      }
      session.groups = entry.groups;
      session.name = entry.name;
      session.email = entry.email;
      session.verifiedUntil = Date.now() + verifyMs;
      return true;
    },

    /** Ends every session of a user, e.g. when DSM no longer grants the app. */
    revoke(user) {
      let count = 0;
      for (const [key, value] of sessions) {
        if (value.user === user) {
          closeSockets(value);
          sessions.delete(key);
          count++;
        }
      }
      // A token minted a moment earlier must not become a session after the privilege is gone.
      for (const [key, value] of oneTime) {
        if (value.user === user) oneTime.delete(key);
      }
      return count;
    },

    /** The session's identity when the request may pass, else null. */
    authenticate(request) {
      if (config.authMode === "none") {
        return { user: "", groups: [] };
      }
      const entry = find(request);
      if (!entry) {
        return null;
      }
      // Idle timeout, not a hard limit: someone using the app is never signed out mid-task.
      entry.expiresAt = Date.now() + sessionMs;
      return entry;
    },

    /** Drops every bridge session cookie, also other packages' on the same host. */
    stripCookies(cookie) {
      if (!cookie) {
        return cookie;
      }
      return cookie
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part && !/^dsm_bridge_session(_[a-z0-9-]+)?=/.test(part))
        .join("; ");
    },

    cookie(session, secure = false, path = "/") {
      // A browser-session cookie: the bridge enforces the idle timeout, so the cookie must not
      // expire on its own while the app is in use. The path (or, for an app at the root of its
      // own ports, the name) keeps it to this package, so two packages open side by side never
      // replace each other's session.
      return (
        `${cookieName}=${session}; Path=${path}; HttpOnly; SameSite=Lax` +
        (secure ? "; Secure" : "")
      );
    },
  };
}

function cookieValues(header, name) {
  if (!header) {
    return [];
  }
  return header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1))
    .filter(Boolean);
}
