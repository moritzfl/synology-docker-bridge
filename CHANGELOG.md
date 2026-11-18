# Changelog

All notable changes to synology-docker-bridge are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions up to 0.2.0 were not released on their own; AirPlay Capture 2.0.0 ships 0.2.0
(`d636fe8`), and the first section below lists the changes since then.

## [Unreleased]

### Added

- **Open in new tab** on the Login Portal page too, left of the account name in DSM's header, so
  phones can show the app without that header. Added to the Home Screen, the tab opens like an
  app, with the app's name and icon.

### Fixed

- The bridge's own pages (the app is starting, sign-in required) declare their language, so
  screen readers read the German pages in German.
- The bridge no longer follows symlinks that an app places in its data folder: the shared identity
  secret and the settings file are opened without following links and written under fresh random
  names, so the root bridge cannot be pointed at another file.

## [0.3.0] - 2026-11-18

### Added

- **Settings** (`configFile`): administrators edit a settings file in the app's data folder under
  **Manage → Settings…**. Saving runs the app's own check first (`check`), restarts the app and
  waits until it is up (`ready`, `timeout`). If the app does not stay up, the previous file comes
  back and the editor reopens with the app's log. A restart of the bridge or the NAS in between
  does not leave a broken file behind.
- **Open in new tab**: a button in the window's title bar opens the app full page in a browser tab,
  for every user. The tab stays signed in like the window, survives a reload, and its address can
  be bookmarked.
- **Update hint** (`updates`): once a day the bridge looks for newer tags of the published image,
  on any registry. Administrators see an **Update available** button that links to the new
  package and can skip a version.
- **Ports of their own** (`webPorts`): apps that only work at the root of an address get two ports,
  served by DSM's web server with DSM's certificate. Their `publicPaths` are served there too, at
  the root and including WebSockets, and `publicCookies` names the app's cookies that visitors
  without a session keep, such as a CSRF cookie.
- **Unmodified images**: `files` mounts files the package brings into the app's container,
  read-only, and `command` replaces the image's start command.
- **Identity**: with `identityHeaders`, the app also receives `Remote-Name` (the DSM full name, in
  UTF-8) and `Remote-Email` (the address of a local DSM user).

### Changed

- A `publicPaths` entry with a trailing slash also allows the path itself.
- Non-square SVG icons are centered instead of stretched.

### Fixed

- A browser that reset a WebSocket while the app was still starting no longer stops the bridge.

[Unreleased]: https://github.com/moritzfl/synology-docker-bridge/compare/0.3.0...HEAD
[0.3.0]: https://github.com/moritzfl/synology-docker-bridge/compare/d636fe8...0.3.0
