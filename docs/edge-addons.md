# Microsoft Edge Add-ons release

1. Enroll in the Microsoft Edge program through Partner Center. On Windows, run `pnpm package:extension` and upload `release/PassWards-extension-<version>-edge-addons.zip` as a new extension. [Developer registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
2. Copy the 32-letter extension ID from the listing URL into `edgeAddonsId` in `browser-extension/identity.json`. Build the desktop EXE with `pnpm build:app`. Provide a download link for this build in the certification notes. Keep the ID unset in desktop builds distributed before the listing is installable.
3. Set visibility to **Hidden** for distribution by direct link. Add the 128×128 logo in `browser-extension/icons/128.png`, the privacy policy URL and the test instructions. `pnpm test:extension` produces a 1280×800 screenshot of the account picker with fictional data at `artifacts/extension-inline-logins.png`. [Publishing guide](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
4. Once the listing passes certification, verify on a clean Edge profile with Developer Mode off. In PassWards, choose **Settings → Browsers → Edge** and select **Get** from the store page that opens. Open the extension with the vault unlocked. Verify the connection appears in PassWards, then test saving and filling a fictional login with desktop approval.

## Listing description

Save, update and fill website logins with the PassWards desktop vault. PassWards detects supported sign-in forms, offers matching accounts and lets you approve each save or fill in the desktop app. Requires the PassWards desktop app for Windows. Create a local vault, open Settings → Browsers and open the extension to connect.

## Reviewer test instructions

Use Windows 10 or 11 with WebView2. Provide the direct download URL for the desktop build from step 2. Run PassWards and create a local vault with a temporary master password. In Settings → Browsers, choose **Enable connection** or **Repair connection**. Open the installed extension in Edge while the vault is unlocked. Create a fictional login in PassWards with the full URL of a standard sign-in page. On that page, open the extension, select the fictional entry and choose **Fill**. Approve the request with the temporary master password and verify the form fields. Leave automatic sign-in off. To test saving, enter different fictional credentials, select **Save entered login** in the extension and approve the request in PassWards. No Devtune account is needed for these steps.

## Privacy and permission disclosures

The extension reads supported sign-in fields and the current site address to find matching logins, offer saves and fill the chosen account. When the user selects Save or Update, the extension sends the proposed credentials and available cached site icon to the desktop app on the same device for approval. The app stores them in the encrypted vault after approval. The extension stores its connection token and preferences in the local browser profile. It does not transmit logins or browsing activity to PassWards servers. The desktop app offers a separate, opt-in encrypted vault backup feature. Describe these uses in the published extension privacy policy. [Microsoft Edge Add-ons developer policies](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)

- `nativeMessaging` connects the extension to the local desktop vault for pairing, matching and desktop approval.
- `storage` retains the connection token and preferences in the browser profile.
- `scripting` runs capture and fill code in the selected tab, after verifying the tab and document.
- `activeTab` supports user-initiated access to the current tab.
- `favicon` reads the site's icon from the browser cache for a saved login.
- HTTP and HTTPS site access lets the extension detect sign-in forms and offer matching accounts across sites.

The extension ships all of its executable code in the ZIP.
