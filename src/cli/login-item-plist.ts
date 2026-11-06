export const LOGIN_ITEM_LABEL = "com.konfab.server";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function loginItemPlist(options: {
  nodePath: string;
  serverPath: string;
  workingDirectory: string;
  logPath: string;
}): string {
  const text = (value: string): string =>
    `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${text(LOGIN_ITEM_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${text(options.nodePath)}
    ${text(options.serverPath)}
  </array>
  <key>WorkingDirectory</key>
  ${text(options.workingDirectory)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  ${text(options.logPath)}
  <key>StandardErrorPath</key>
  ${text(options.logPath)}
</dict>
</plist>
`;
}
