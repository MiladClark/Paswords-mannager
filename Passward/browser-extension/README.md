# Passward — Chrome / Edge

## نصب

1. نسخهٔ ۰٫۳ Passward را اجرا و خزانه را باز کنید. نسخهٔ قدیمی در حال اجرا را ابتدا ببندید.
2. در Chrome آدرس `chrome://extensions` و در Edge آدرس `edge://extensions` را باز کنید. Developer mode را روشن کنید، **Load unpacked** را بزنید و پوشه‌ای را انتخاب کنید که `manifest.json` داخل آن است. این نسخه هنوز در فروشگاه مرورگر منتشر نشده است.
3. در اپ: **Settings → Browsers → Enable browser connection**. سپس **Pair browser** را بزنید.
4. افزونهٔ Passward را از نوار مرورگر باز کنید، مرورگر را انتخاب و کد شش‌رقمی اپ را وارد کنید. کد یک‌بارمصرف و دو دقیقه معتبر است. برای هر مرورگر یا پروفایل جداگانه جفت‌سازی کنید.

اتصال Native Messaging برای حساب فعلی Windows ثبت می‌شود و دسترسی ادمین نمی‌خواهد. اگر فایل اجرایی اپ را جابه‌جا کردید یا نسخهٔ نصب‌شدهٔ دیگری را اجرا کردید، **Repair connection** را در همان اپ بزنید. اسکریپت اختیاری `Install-Bridge.ps1 -AppPath 'C:\path\Passward.exe'` همین ثبت را انجام می‌دهد؛ نیاز به تغییر ExecutionPolicy کل سیستم نیست.

## استفاده

- در آیتم خزانه، Website را با آدرس کامل سایت ذخیره کنید، مثلاً `https://accounts.example.com`. scheme، دامنه و port باید با صفحهٔ ورود یکسان باشند؛ مسیر URL می‌تواند متفاوت باشد.
- صفحهٔ ورود را باز کنید، افزونه را بزنید و حساب را انتخاب کنید. گزینهٔ **Fill** درخواست را به اپ می‌فرستد؛ دامنه و حساب را در اپ بررسی کنید و با PIN چهاررقمی یا رمز اصلی تأیید کنید.
- پس از تأیید، فیلدهای قابل‌مشاهده پر می‌شوند؛ دکمهٔ ورود خودکار زده نمی‌شود. ورود چندمرحله‌ای در هر صفحه با انتخاب مجدد Fill انجام می‌شود.
- با **Always detect logins on this site**، تشخیص خودکار همان سایت را فعال کنید. در بازدیدهای بعد، پیشنهاد کوچک Passward و تعداد حساب‌ها کنار صفحه ظاهر می‌شود. بدون این مجوز، بازکردن افزونه فقط برای تب فعلی دسترسی موقت می‌دهد.
- برای قطع دسترسی یک مرورگر از **Settings → Browsers → Disconnect** در اپ استفاده کنید. Disconnect خود افزونه فقط توکن همان پروفایل را از مرورگر پاک می‌کند.
- میان‌بر بازکردن افزونه: `Alt+Shift+P`؛ مرورگر ممکن است این میان‌بر را به برنامهٔ دیگری اختصاص داده باشد.

رابط افزونه فارسی و انگلیسی و دارای تم روشن و تیره است. خزانه، PIN و رمز اصلی داخل افزونه ذخیره نمی‌شوند. توکن اتصال و تنظیمات غیرحساس در فضای اختصاصی افزونه ذخیره می‌شوند؛ هر Autofill همچنان به تأیید داخل اپ نیاز دارد.

## محدودهٔ پشتیبانی

فرم‌های استاندارد ورود، فرم‌های دارای `autocomplete`، رمز تنها، ورود username-first و بسیاری از فرم‌های React با رویدادهای `input/change` پشتیبانی می‌شوند. فرم ثبت‌نام، فیلد مخفی، OTP/PIN، فرم با مقصد سایت دیگر و iframeهای ورود در این نسخه پر نمی‌شوند. برای ورود داخل iframe، صفحهٔ اصلی سرویس ورود را در تب مستقل باز کنید. فرم‌های کاملاً سفارشی، فیلدهای داخل shadow root بسته یا صفحه‌ای که اجازهٔ افزونه نمی‌دهد ممکن است به کپی دستی نیاز داشته باشند. هیچ افزونه‌ای نمی‌تواند سازگاری با همهٔ سایت‌ها را تضمین کند.

ذخیرهٔ خودکار حساب تازه، پیشنهاد تغییر رمز، Passkey و Firefox در این نسخه پیاده نشده‌اند.

## مشکل اتصال

- **Open Passward**: اپ را باز می‌کند؛ سپس خزانه را باز کنید و Refresh بزنید. پیشنهادهای خودکار سایت اپ بسته را خودکار اجرا نمی‌کنند.
- **No saved account**: Website آیتم را با آدرس فعلی مقایسه کنید؛ دامنهٔ اصلی و زیردامنه یکسان نیستند.
- **No supported login form**: صفحهٔ ورود را کامل باز کنید؛ ثبت‌نام و جست‌وجو فرم ورود محسوب نمی‌شوند.
- **Request expired / page changed**: دوباره Fill را بزنید و هنگام تأیید، همان صفحه را باز نگه دارید. درخواست ۹۰ ثانیه اعتبار دارد و پس از یک بار دریافت مصرف می‌شود.
- **Browser connection unavailable**: در اپ Repair connection را بزنید، فایل اجرایی را جابه‌جا نکنید و افزونه را Reload کنید.

## Developer notes

Manifest V3; stable unpacked extension ID `mhofghlpaigblofliecafkfgeklbgfdi`. Native host `com.passward.bridge`. No remote scripts or libraries; no page-value collection or form submission listener. The content script requests matching account metadata; credentials only enter the isolated content world after a fresh desktop approval and final tab/document/origin checks.

Official APIs: [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging), [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting), [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage).
