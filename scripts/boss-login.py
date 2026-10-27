"""Open the same persistent Chrome used by the plugin; never export cookies."""
from pathlib import Path
import os
import sys
from boss_browser import open_browser
os.umask(0o077)
try:
    open_browser(Path(sys.argv[1]), official=True)
    print('已打开专用 Chrome。请本人登录后回到插件连接；如有验证提示，请按插件引导确认。')
except Exception:
    print('未能打开专用 Chrome，请确认本机已安装 Google Chrome。', file=sys.stderr)
    sys.exit(1)
