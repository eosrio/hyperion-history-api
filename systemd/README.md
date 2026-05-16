# Running Hyperion without pm2 (systemd)

pm2 remains the **default and recommended** way to run Hyperion. These unit
templates are an **opt-in** alternative for operators who don't want pm2. They
do not change anything for pm2 users.

## Scope / limitations

- **API runs as a single instance.** pm2's `exec_mode:'cluster'` multi-worker
  scaling is not reproduced; `api.pm2_scaling` in the chain config is a no-op
  without pm2. Need a multi-instance API? Keep pm2, or run several
  `hyperion-api@<chain>` units behind a reverse proxy.
- The indexer is unaffected — it already manages its own Node cluster and is
  stopped gracefully via the controller, with or without pm2.

## Install (chain `wax` as the example)

```bash
sudo cp systemd/hyperion-indexer@.service systemd/hyperion-api@.service /etc/systemd/system/
sudoedit /etc/systemd/system/hyperion-indexer@.service   # set User= and WorkingDirectory=
sudoedit /etc/systemd/system/hyperion-api@.service       # set User= and WorkingDirectory=
sudo systemctl daemon-reload

sudo systemctl enable --now hyperion-indexer@wax
sudo systemctl enable --now hyperion-api@wax
```

## Operate

| Task | Command |
|---|---|
| Logs (replaces `pm2 logs`) | `journalctl -u hyperion-api@wax -f` |
| Stop indexer (graceful flush) | `sudo systemctl stop hyperion-indexer@wax` |
| Stop API | `sudo systemctl stop hyperion-api@wax` |
| Status | `systemctl status hyperion-api@wax` |

`./run` and `./stop` can drive systemd instead of pm2 — prefix with
`HYP_NO_PM2=1` (e.g. `HYP_NO_PM2=1 ./stop wax-api`). With it unset, both
scripts use pm2 exactly as before.

Stopping the indexer unit runs the same graceful controller stop as
`./hyp-control indexer stop wax`; it is never hard-killed mid-write
(`TimeoutStopSec=600`, `Restart=no`, matching pm2 `autorestart:false`).
