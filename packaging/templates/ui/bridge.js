(function () {
  var token = "";
  try {
    token = _S("SynoToken") || "";
  } catch (ignore) {}

  var NAME = "{{displayName}}";
  var BASE = "/webman/3rdparty/{{id}}/";
  var SHOW_OUTPUT = {{showOutput}};
  // The app runs as the package's own DSM user, whose folder permissions administrators manage.
  var PACKAGE_USER = {{packageUser}};
  var PACKAGE_USER_NAME = "{{id}}";
  var OUTPUT_LABEL = {{outputLabelJson}};
  // Where folders may be; the package may have fallen back to its own share on this NAS.
  var OUTPUT_PARENT = "{{outputParent}}";
  var APP_ID = "SYNO.SDS.{{dsmAppName}}.Instance";
  var PORTAL_ALIAS = "{{id}}";
  var TEXTS = {{texts}};
  var LANG = "enu";
  try {
    LANG = _S("lang") || LANG;
  } catch (ignore) {}
  var STRINGS = TEXTS[LANG] || TEXTS.enu;

  function t(key, values) {
    var text = STRINGS[key] || TEXTS.enu[key] || key;
    values = values || {};
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      if (name === "app") return NAME;
      if (name === "folder") return label();
      return name in values ? values[name] : match;
    });
  }

  /** The folder's name in the user's language, e.g. "Recordings folder". */
  function label() {
    return OUTPUT_LABEL[LANG] || OUTPUT_LABEL.enu;
  }

  // Short, human explanations instead of raw helper codes.
  var ERRORS = {
    auth: "error.auth",
    denied: "error.denied",
    admin: "error.admin",
    token: "error.token",
    origin: "error.origin",
    bridge: "error.bridge",
    "bridge-port": "error.install",
    "bridge-token": "error.install",
  };

  // Docker states are not words users should have to learn.
  var STATES = {
    running: "",
    restarting: "state.restarting",
    created: "state.starting",
    paused: "state.paused",
    exited: "state.stopped",
    dead: "state.stopped",
    missing: "state.missing",
  };

  function explain(error) {
    var key = ERRORS[error && error.code];
    return key ? t(key) : t("unknownError");
  }

  /** Calls one of DSM's own web APIs as the signed-in administrator. */
  function webapi(api, method, version, params) {
    var query = "api=" + encodeURIComponent(api) + "&method=" + method + "&version=" + version;
    Object.keys(params || {}).forEach(function (key) {
      query += "&" + key + "=" + encodeURIComponent(JSON.stringify(params[key]));
    });
    return fetch("/webapi/entry.cgi", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-SYNO-TOKEN": token },
      body: query,
      credentials: "same-origin",
      cache: "no-store",
    }).then(function (response) { return response.json(); }).then(function (data) {
      if (!data.success) {
        var error = new Error("DSM error " + (data.error && data.error.code));
        error.code = "dsm-" + (data.error && data.error.code);
        throw error;
      }
      return data.data || {};
    });
  }

  function isInsideParent(path) {
    var value = String(path || "").replace(/\/+$/, "");
    return value.indexOf(OUTPUT_PARENT + "/") === 0 && value.length > OUTPUT_PARENT.length + 1;
  }

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    headers["X-SynoToken"] = token;
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }
    var url = path + (path.indexOf("?") >= 0 ? "&" : "?")
      + "SynoToken=" + encodeURIComponent(token);
    return fetch(url, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
    }).then(function (response) {
      return response.json().catch(function () {
        return { error: "bridge" };
      }).then(function (data) {
        if (!response.ok || data.error) {
          var error = new Error(data.error || ("HTTP " + response.status));
          error.code = data.error || "";
          throw error;
        }
        return data;
      });
    });
  }

  function alertBox(title, message, callback) {
    if (Ext.Msg && Ext.Msg.alert) {
      Ext.Msg.alert(title, message, callback);
    } else {
      window.alert(title + "\n\n" + message);
      if (callback) callback();
    }
  }

  // DSM's own widgets where available, so the window looks first-party; plain Ext otherwise.
  function ux(name, fallback) {
    return (window.SYNO && SYNO.ux && SYNO.ux[name]) || fallback;
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function isAdmin() {
    try {
      return !!_S("is_admin");
    } catch (ignore) {
      return false;
    }
  }

  /** Opened through its Login Portal address: DSM shows only this app, full page. */
  function isStandalone() {
    try {
      return !!_S("standalone");
    } catch (ignore) {
      return false;
    }
  }

  // DSM's single-app page declares no viewport, so phones lay it out 980 pixels wide and the
  // app's own mobile layout never applies. Ask for the device width, and name the page for the
  // Home Screen. iOS reads these when the page loads, before the user adds it.
  function fitPhoneScreen() {
    var head = document.head;
    function meta(name, content) {
      var element = head.querySelector('meta[name="' + name + '"]');
      if (!element) {
        element = document.createElement("meta");
        element.setAttribute("name", name);
        head.appendChild(element);
      }
      element.setAttribute("content", content);
    }
    meta("viewport", "width=device-width, initial-scale=1, viewport-fit=cover");
    meta("apple-mobile-web-app-capable", "yes");
    meta("mobile-web-app-capable", "yes");
    meta("apple-mobile-web-app-title", NAME);
    var icon = head.querySelector('link[rel="apple-touch-icon"]');
    if (!icon) {
      icon = document.createElement("link");
      icon.setAttribute("rel", "apple-touch-icon");
      head.appendChild(icon);
    }
    icon.setAttribute("href", BASE + "images/app_256.png");
    document.title = NAME;
  }

  Ext.define("SYNO.SDS.{{dsmAppName}}.Instance", {
    extend: "SYNO.SDS.AppInstance",
    appWindowName: "SYNO.SDS.{{dsmAppName}}.Main",
    constructor: function () {
      this.callParent(arguments);
    },
  });

  Ext.define("SYNO.SDS.{{dsmAppName}}.Main", {
    extend: "SYNO.SDS.AppWindow",
    constructor: function (cfg) {
      var self = this;
      var windowId = Ext.id(null, "{{id}}-window-");
      var iframeId = windowId + "-frame";
      var wrapperUrl = BASE + "app.html?SynoToken=" + encodeURIComponent(token)
        + "&lang=" + encodeURIComponent(LANG) + "&windowId=" + encodeURIComponent(windowId);
      var Button = ux("Button", Ext.Button);
      var standalone = isStandalone();
      // The window holds the app and nothing else. The one package setting, the folder, is
      // offered to administrators as a single button named after it; everyone else gets no
      // toolbar at all. Restart lives where it helps (the "not responding" screen) and in
      // Package Center's Stop/Run.
      var tbar = null;
      if (isAdmin() && !standalone) {
        var items = [];
        if (SHOW_OUTPUT) {
          items.push({ text: label() + "…", handler: function () { self.openSettings(); } });
        }
        if (PACKAGE_USER) {
          items.push({ text: t("accessMenu"), handler: function () { self.openAccess(); } });
        }
        items.push({ text: t("phoneButton"), handler: function () { self.openPhone(); } });
        // Several tasks: DSM's toolbar dropdown, like File Station's Tools, keeps them to one button.
        this.manageButton = items.length > 1
          ? new Button({ text: t("manage"), menu: new Ext.menu.Menu({ items: items }) })
          : new Button(items[0]);
        tbar = [this.manageButton];
      }
      if (standalone) {
        fitPhoneScreen();
      }
      var config = Ext.apply({
        id: windowId,
        title: NAME,
        width: {{width}},
        height: {{height}},
        // A Login Portal page on a phone is narrower than any desktop window.
        minWidth: standalone ? 0 : 900,
        minHeight: standalone ? 0 : 560,
        // DSM's "?" opens its help on an empty page: packages have no help entry.
        showHelp: false,
        layout: "fit",
        tbar: tbar,
        items: [
          new Ext.BoxComponent({
            height: "100%",
            html: '<iframe id="' + iframeId + '" title="' + escapeHtml(NAME) + '" '
              + 'style="border:0;width:100%;height:100%;display:block;background:#f4f6f8" '
              + 'src="' + wrapperUrl + '"></iframe>',
          }),
        ],
      }, cfg);
      this.callParent([config]);
      this.iframeId = iframeId;
      if (standalone) {
        this.refitOnResize();
      }
      // DSM renders the AppWindow during its own launch sequence, so "afterrender" may already
      // have fired here; ask directly.
      this.loadStatus();
      this.on("show", function () { self.loadStatus(); });
      function shown(event) {
        if (event.origin === window.location.origin && event.data
            && event.data.type === "bridge:shown" && event.data.windowId === windowId) {
          // The app answered and is on screen; a slow status probe must not call it starting.
          self.setTitle(NAME);
        }
      }
      window.addEventListener("message", shown);
      this.on("destroy", function () { window.removeEventListener("message", shown); });
      if (PACKAGE_USER && isAdmin() && !standalone) {
        // Right after installing, the app may not yet be allowed into its folders; say so at once.
        this.checkAccessQuietly();
      }
    },

    /**
     * DSM sizes the full-page window once, at launch, from the page width before the phone
     * viewport took effect (980 pixels on iOS), and Safari sends no resize event for the viewport
     * change. Follow the page's real size instead; DSM's own layout pass then refits the window.
     */
    refitOnResize: function () {
      var self = this;
      var pending = false;
      function refit() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () {
          pending = false;
          if (self.isDestroyed || !self.rendered) return;
          if (SYNO.SDS.Desktop && SYNO.SDS.Desktop.doLayout) {
            SYNO.SDS.Desktop.doLayout();
          } else {
            self.onWindowResize();
          }
        });
      }
      if (window.ResizeObserver) {
        new ResizeObserver(refit).observe(document.body);
      }
      window.addEventListener("resize", refit);
      this.on("afterrender", refit);
      refit();
    },

    /**
     * DSM's full-page header hides its account menu's Sign Out together with Help when a window
     * turns Help off, which leaves a tap on the user name with an empty menu. Build the header
     * with Help on, then hide only Help: packages have no help page.
     */
    genIndPortHeader: function () {
      var showHelp = this.showHelp;
      this.showHelp = true;
      try {
        this.callParent(arguments);
      } finally {
        this.showHelp = showHelp;
      }
      Ext.ComponentMgr.all.each(function (component) {
        var menu = component.ownerCt;
        if (/(^|\s)sds-standalone-help(\s|$)/.test(component.cls || "") && menu
            && String(menu.cls || "").indexOf("sds-standalone-main-window-header__toolbar__menu") >= 0) {
          component.hide();
        }
      });
    },

    loadStatus: function () {
      var self = this;
      return api(BASE + "status.cgi").then(function (data) {
        self.status = data;
        var key = STATES[data.state];
        if (data.state === "running" && !data.reachable) key = "state.starting";
        var state = key === undefined ? data.state : (key ? t(key) : "");
        self.setTitle(NAME + (state ? " · " + state : ""));
        return data;
      }).catch(function (error) {
        self.setTitle(NAME + " · " + t("state.unavailable"));
        console.warn("bridge status failed", error);
      });
    },

    /** Lets the embedded wrapper show progress and reveal the app once it answers. */
    notifyFrame: function (type, extra) {
      var frame = document.getElementById(this.iframeId);
      if (frame && frame.contentWindow) {
        frame.contentWindow.postMessage(Ext.apply({ type: type }, extra || {}),
          window.location.origin);
      }
    },

    whenReady: function () {
      var self = this;
      // The wrapper reloads the app itself; keep the title in step until it is back.
      var attempts = 0;
      (function poll() {
        self.loadStatus().then(function (status) {
          attempts++;
          if (status && status.state === "running" && status.reachable) return;
          if (attempts < 80) setTimeout(poll, 1500);
        });
      })();
    },

    openSettings: function () {
      var self = this;
      if (this.settingsWindow && !this.settingsWindow.isDestroyed) {
        this.settingsWindow.close();
        this.settingsWindow = null;
      }
      // Always read the live value; another administrator may have changed it.
      this.getEl().mask(t("loading"));
      api(BASE + "status.cgi").then(function (status) {
        self.getEl().unmask();
        self.status = status;
        self.showSettings(status);
      }).catch(function (error) {
        self.getEl().unmask();
        alertBox(label(), explain(error));
      });
    },

    showSettings: function (status) {
      var self = this;
      OUTPUT_PARENT = status.outputParent || OUTPUT_PARENT;
      var TextField = ux("TextField", Ext.form.TextField);
      var Button = ux("Button", Ext.Button);
      var Composite = ux("CompositeField", Ext.form.CompositeField);
      var FormPanel = ux("FormPanel", Ext.form.FormPanel);
      // The chooser cannot be limited to one share, so say where the folder must be, start the
      // chooser there, and reject anything else next to the field instead of after Save.
      var outputField = new TextField({
        value: status.outputDir || "{{defaultOutputDir}}",
        width: 340,
        allowBlank: false,
        validator: function (value) {
          return isInsideParent(value) || t("folderOutside", { parent: OUTPUT_PARENT });
        },
      });
      var browse = new Button({
        text: t("folderBrowse"),
        handler: function () {
          var chooser = new SYNO.SDS.Utils.FileChooser.Chooser({
            owner: self,
            title: t("folderChoose"),
            usage: { type: "chooseDir", multiple: false },
            gotoPath: outputField.getValue() || OUTPUT_PARENT,
            needrw: false,
            enumRecycle: false,
            folderToolbar: true,
            listeners: {
              choose: function (dialog, selection) {
                outputField.setValue(selection.fullpath);
                outputField.validate();
                dialog.close();
              },
            },
          });
          chooser.show();
        },
      });
      var moveField = new SYNO.ux.Checkbox({ boxLabel: t("folderMove"), checked: true });
      var form = new FormPanel({
        border: false,
        bodyPadding: 12,
        labelWidth: 130,
        items: [
          // a composite field carries the label; fields inside an hbox would render without one
          new Composite({ fieldLabel: label(), items: [outputField, browse] }),
          {
            xtype: "box",
            html: "<div style=\"color:#6b7685;font-size:12px;margin:-2px 0 8px 135px\">"
              + escapeHtml(t("folderInside", { parent: OUTPUT_PARENT })) + "</div>",
          },
          moveField,
        ],
      });
      this.settingsWindow = new SYNO.SDS.ModalWindow({
        owner: this,
        title: label(),
        width: 640,
        height: 220,
        layout: "fit",
        items: [form],
        buttons: [
          {
            xtype: "syno_button",
            btnStyle: "grey",
            text: t("cancel"),
            handler: function () { self.settingsWindow.close(); },
          },
          {
            xtype: "syno_button",
            btnStyle: "blue",
            text: t("save"),
            handler: function () {
              if (!form.getForm().isValid()) return;
              if (outputField.getValue() === status.outputDir) {
                self.settingsWindow.close();
                return;
              }
              var body = { outputDir: outputField.getValue(), moveExisting: moveField.getValue() };
              self.settingsWindow.getEl().mask(body.moveExisting
                ? t("movingAndRestarting") : t("applying"));
              self.notifyFrame("bridge:busy", {
                title: t("restarting"),
                message: t(body.moveExisting ? "movingFiles" : "switchingFolder"),
              });
              api(BASE + "settings.cgi", { method: "POST", body: body }).then(function (data) {
                self.settingsWindow.getEl().unmask();
                self.settingsWindow.close();
                self.status = data;
                self.notifyFrame("bridge:restarting");
                self.whenReady();
                if (PACKAGE_USER) self.checkAccessQuietly();
                var skipped = (data.skipped || []).length;
                if (skipped) {
                  alertBox(t("skippedTitle"), escapeHtml(t("skipped",
                    { count: skipped, folder: status.outputDir })));
                }
              }).catch(function (error) {
                self.settingsWindow.getEl().unmask();
                self.notifyFrame("bridge:reload");
                alertBox(t("settingsFailed"), escapeHtml(explain(error)));
              });
            },
          },
        ],
      });
      this.settingsWindow.show();
    },

    /**
     * Login Portal can give the app an address of its own, which is how it opens on phones. Only
     * an administrator can change that, and DSM keeps it off until someone does, like for its own
     * apps; show the address and let the administrator turn it on or off here instead of
     * sending people to search Control Panel.
     */
    openPhone: function () {
      var self = this;
      if (this.phoneWindow && !this.phoneWindow.isDestroyed) {
        this.phoneWindow.close();
      }
      var body = new Ext.BoxComponent({ html: "" });
      var Button = ux("Button", Ext.Button);
      // DSM rejects an empty alias; null removes it, and fqdn: null also drops a host name that
      // was set in Control Panel, so "off" means no own address at all.
      function change(settings, failure) {
        self.phoneWindow.getEl().mask(t("applying"));
        return webapi("SYNO.Core.AppPortal", "set", 2, Ext.apply({ id: APP_ID }, settings))
          .then(function () { return render(); })
          .catch(function (error) { render(t(failure, { reason: error.message })); })
          .then(function () { self.phoneWindow.getEl().unmask(); });
      }
      var turnOn = new Button({
        text: t("phoneTurnOn"),
        hidden: true,
        btnStyle: "blue",
        handler: function () { change({ alias: PORTAL_ALIAS }, "phoneFailed"); },
      });
      var turnOff = new Button({
        text: t("phoneTurnOff"),
        hidden: true,
        btnStyle: "grey",
        handler: function () { change({ alias: null, fqdn: null }, "phoneOffFailed"); },
      });
      function paragraph(text, style) {
        return "<p style=\"margin:0 0 10px;" + (style || "") + "\">" + escapeHtml(text) + "</p>";
      }
      function render(problem) {
        return webapi("SYNO.Core.AppPortal", "get", 2, { id: APP_ID }).then(function (portal) {
          var address = "";
          if (portal.alias) {
            address = window.location.origin + "/" + portal.alias + "/";
          } else if (portal.fqdn) {
            address = window.location.protocol + "//" + portal.fqdn + "/";
          }
          var html = "";
          if (address) {
            html += paragraph(t("phoneOn"));
            html += "<p style=\"margin:0 0 14px\"><a href=\"" + escapeHtml(address)
              + "\" target=\"_blank\" rel=\"noopener\" style=\"font-size:14px\">"
              + escapeHtml(address) + "</a></p>";
          } else {
            html += paragraph(t("phoneOff"));
          }
          if (problem) html += paragraph(problem, "color:#d03030");
          html += paragraph(t("phoneSettings"), "color:#6b7685;font-size:12px");
          body.update(html);
          turnOn.setVisible(!address);
          turnOff.setVisible(!!address);
        }, function (error) {
          body.update(paragraph(explain(error)));
        });
      }
      this.phoneWindow = new SYNO.SDS.ModalWindow({
        owner: this,
        title: t("phoneSection"),
        width: 520,
        height: 230,
        layout: "fit",
        items: [new Ext.Panel({ border: false, bodyStyle: "padding:16px 20px", items: [body] })],
        buttons: [
          turnOn,
          turnOff,
          {
            xtype: "syno_button",
            btnStyle: "grey",
            text: t("close"),
            handler: function () { self.phoneWindow.close(); },
          },
        ],
      });
      this.phoneWindow.show();
      render();
    },

    /** Opens Folder access only when a folder needs attention; silent otherwise. */
    checkAccessQuietly: function () {
      var self = this;
      api(BASE + "access.cgi").then(function (data) {
        if ((data.folders || []).some(function (folder) { return !accessOk(folder); })) {
          self.openAccess(data);
        }
      }).catch(function (error) {
        console.warn("folder access check failed", error);
      });
    },

    /**
     * The folders the app uses and whether its own user may read and write them. DSM's
     * permissions decide; this window never changes them. Each folder opens DSM's own permission
     * dialog for it, ready on the package user, and the check repeats when that dialog closes.
     */
    openAccess: function (prefetched) {
      var self = this;
      if (this.accessWindow && !this.accessWindow.isDestroyed) {
        this.accessWindow.toFront();
        return;
      }
      var folders = [];
      var body = new Ext.BoxComponent({ html: "" });
      function render(data) {
        folders = data.folders || [];
        var html = "<p style=\"margin:0 0 12px\">" + escapeHtml(t("accessIntro", { user: PACKAGE_USER_NAME }))
          + "</p><table style=\"width:100%;border-collapse:collapse\">";
        folders.forEach(function (folder, index) {
          var ok = accessOk(folder);
          var state = !folder.exists ? t("accessMissing")
            : ok ? t("accessOk")
            : folder.read ? t("accessReadOnly")
            : folder.share && !folder.shareOpen ? t("accessShareClosed", { share: shareName(folder.share) })
            : t("accessNone");
          html += "<tr style=\"border-top:1px solid #e3e7ec\">"
            + "<td style=\"padding:8px 8px 8px 0\"><div style=\"font-weight:bold\">"
            + escapeHtml(folder.key === "output" ? label() : t("accessData")) + "</div>"
            + "<div style=\"color:#6b7685;font-size:12px;word-break:break-all\">" + escapeHtml(folder.path) + "</div></td>"
            + "<td style=\"padding:8px;white-space:nowrap;color:" + (ok ? "#1e9e45" : "#d03030") + "\">"
            + escapeHtml(state) + "</td>"
            + "<td style=\"padding:8px 0;text-align:right;white-space:nowrap\">"
            + (folder.exists ? "<a href=\"#\" data-folder=\"" + index + "\">" + escapeHtml(t("accessPermissions")) + "</a>" : "")
            + "</td></tr>";
        });
        html += "</table><p style=\"margin:12px 0 0;color:#6b7685;font-size:12px\">"
          + escapeHtml(t("accessHint", { user: PACKAGE_USER_NAME })) + "</p>";
        body.update(html);
      }
      function check() {
        if (!self.accessWindow || self.accessWindow.isDestroyed) return Promise.resolve();
        self.accessWindow.getEl().mask(t("accessChecking"));
        return api(BASE + "access.cgi").then(render).catch(function (error) {
          body.update("<p>" + escapeHtml(explain(error)) + "</p>");
        }).then(function () {
          if (self.accessWindow && !self.accessWindow.isDestroyed) self.accessWindow.getEl().unmask();
        });
      }
      this.accessWindow = new SYNO.SDS.ModalWindow({
        owner: this,
        title: t("accessTitle"),
        width: 640,
        height: 330,
        layout: "fit",
        items: [new Ext.Panel({ border: false, autoScroll: true, bodyStyle: "padding:16px 20px", items: [body] })],
        buttons: [
          {
            xtype: "syno_button",
            btnStyle: "grey",
            text: t("accessCheck"),
            handler: check,
          },
          {
            xtype: "syno_button",
            btnStyle: "blue",
            text: t("close"),
            handler: function () { self.accessWindow.close(); },
          },
        ],
      });
      this.accessWindow.show();
      this.accessWindow.body.on("click", function (event, target) {
        var folder = folders[Number(target.getAttribute("data-folder"))];
        event.preventDefault();
        if (!folder) return;
        // While the shared folder itself is closed to the app, that is the permission to change.
        var target = folder.share && !folder.shareOpen ? folder.share : folder.path;
        self.openPermissions(target).then(function (dialog) {
          if (dialog) dialog.on("destroy", check);
        }).catch(function (error) {
          console.warn("permission dialog failed", error);
          alertBox(t("accessTitle"), escapeHtml(t("accessManual", { user: PACKAGE_USER_NAME, path: folder.path })));
        });
      }, null, { delegate: "a[data-folder]" });
      if (prefetched) render(prefetched);
      else check();
    },

    /**
     * DSM's own permission dialog for a folder: the shared folder's Permissions with System
     * internal user and the package user selected, or File Station's permission tab for a folder
     * inside it. Resolves the share through DSM rather than guessing it from the path.
     */
    openPermissions: function (target) {
      var self = this;
      target = String(target || "").replace(/\/+$/, "");
      if (!/^\/volume[^/]*\/[^/]/.test(target) || target.split("/").indexOf("..") >= 0) {
        return Promise.reject(new Error("invalid folder"));
      }
      return webapi("SYNO.FileStation.List", "list_share", 2,
        { additional: ["real_path", "perm"], status_filter: "valid" }).then(function (listed) {
        var share = (listed.shares || []).filter(function (entry) {
          var root = entry.additional && entry.additional.real_path;
          return typeof root === "string" && (target === root || target.indexOf(root + "/") === 0);
        }).sort(function (a, b) {
          return b.additional.real_path.length - a.additional.real_path.length;
        })[0];
        if (!share) throw new Error("shared folder unavailable");
        if (target === share.additional.real_path) {
          return SYNO.SDS.JSLoadPromise("SYNO.SDS.Share.PermissionDialog").then(function () {
            return webapi("SYNO.Core.Share", "get", 1,
              { name: share.name, additional: ["is_aclmode", "encryption"] });
          }).then(function (info) {
            var dialog = new SYNO.SDS.Share.PermissionDialog({ owner: self });
            var grid = dialog.gridPanel;
            // The dialog first lists local users; switch to the package user once it has loaded.
            grid.store.on("load", function () {
              if (dialog.isDestroyed) return;
              var roles = grid.roleFilter.getStore();
              var record = roles.getAt(roles.findExact("role", "system"));
              if (!record) return;
              grid.roleFilter.setValue("system");
              grid.nameFilter.setValue(PACKAGE_USER_NAME);
              grid.store.baseParams.substr = PACKAGE_USER_NAME;
              grid.onRoleFilterSelect(grid.roleFilter, record);
            }, null, { single: true });
            dialog.loadPermissionData(new Ext.data.Record(info));
            return dialog;
          });
        }
        var virtual = share.path + target.slice(share.additional.real_path.length);
        return SYNO.SDS.JSLoadPromise("SYNO.FileStation.PropertyDialog").then(function () {
          return webapi("SYNO.FileStation.List", "getinfo", 2,
            { path: [virtual], additional: ["real_path", "perm"] });
        }).then(function (data) {
          var file = (data.files || [])[0];
          if (!file || !file.isdir || !file.additional || file.additional.real_path !== target
              || !file.additional.perm || !file.additional.perm.is_acl_mode) {
            throw new Error("folder permissions unavailable");
          }
          var dialog = new SYNO.FileStation.PropertyDialog({
            owner: self,
            rec: [new Ext.data.Record(Ext.apply({
              filename: file.name, file_id: file.path, real_path: target, isshare: false,
            }, file))],
            source: SYNO.webfm.utils.source.remote,
            privilegeType: SYNO.SDS.Share.PropertyDialogEnum.privilegeType.acl,
            hideInfoPanel: true,
            hideAdvPermPanel: true,
            title: t("accessPermissionsOf", { path: target }),
            isShareForceRO: !!share.additional.perm && !!share.additional.perm.is_share_readonly,
          });
          dialog.load();
          return dialog;
        });
      });
    },
  });

  function accessOk(folder) {
    return folder.exists && folder.read && folder.write;
  }

  function shareName(sharePath) {
    return String(sharePath).replace(/\/+$/, "").split("/").pop();
  }
})();
