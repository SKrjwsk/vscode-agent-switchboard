# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2]

### Changed
- State colors: green working, red needs approval, yellow your turn, dim yellow dormant (orange looked too close to red)

## [0.1.1]

### Changed
- New icon and logo: a switchboard of four sockets in the state colors
- README: logo, "How it works" diagram, state legend and everyday use cases

## [0.1.0]

### Added
- Panel with three views: Open (running sessions), Favorites and All (folder tree)
- Running sessions from any terminal, matched through `~/.claude/sessions/<pid>.json`; four states by icon color: working, needs approval (the badge counts these), your turn and dormant (idle for 30 minutes or longer), with the colors `agentSwitchboard.working`, `needsApproval`, `yourTurn` and `dormant`
- Resume in an editor tab, start a new session in any folder, read-only transcript preview, search, copy resume command
- Setting `agentSwitchboard.titlePathPrefixes`
