# Stardima Addon — نسخة النشر (ملف واحد)

هذي نسخة جاهزة للنشر على السحابة. المشروع كله مدموج في **`index.js`** واحد
(بدون مجلدات وبدون أي مكتبات خارجية). يكفي ترفع `index.js` + `package.json`.

## النشر على Render (مجاني) — كله من Safari على iPad

### الجزء ١ — ارفع الكود على GitHub
1. افتح **github.com** وسجّل دخول (أو أنشئ حساب مجاني).
2. اضغط **+** (فوق يمين) ← **New repository**.
3. الاسم: `stardima-addon` ← اختر **Public** ← **Create repository**.
4. بصفحة الريبو الفاضي اضغط الرابط الأزرق **uploading an existing file**.
5. من تطبيق **Files** اختر الملفين: `index.js` و `package.json`.
   (إذا نزّلت ZIP: اضغطه مرة بـ Files عشان يفك الضغط، ثم اختر الملفين.)
6. تحت اضغط **Commit changes**.

### الجزء ٢ — انشر على Render
1. افتح **render.com** وسجّل بـ **GitHub** (نفس الحساب).
2. من Dashboard اضغط **New +** ← **Web Service**.
3. اختر ريبو `stardima-addon` ← **Connect**.
4. عبّي الإعدادات:
   - **Name:** أي اسم (مثلاً stardima)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
   - **Instance Type:** **Free**
5. اضغط **Create Web Service** وانتظر ~دقيقتين.
6. يعطيك رابط مثل: `https://stardima-addon.onrender.com`

### الجزء ٣ — ثبّت في Nuvio
رابط الأدئون = رابط Render + `/manifest.json`:
```
https://stardima-addon.onrender.com/manifest.json
```
في Nuvio: **Settings ← Content & Discovery ← Addons ←** الصق الرابط.

## ملاحظات
- **Render المجاني ينام** بعد ~١٥ دقيقة بدون استخدام؛ أول طلب ياخذ ~٣٠ ثانية
  عشان يصحى، وبعدها سريع. (طبيعي ومجاني.)
- على السحابة يصير لك **IP جديد** ← كل سيرفرات البث تشتغل (بدون الـ rate-limit
  اللي صار على IP الاختبار).
- بعض الحلقات محمية VIP/تسجيل دخول على ستارديما ← هذي ما يرجع لها بث.
- بدائل مجانية عن Render: **Railway.app**، **Koyeb**، **Fly.io** — نفس الفكرة
  (اربط ريبو GitHub، Build = `npm install`، Start = `node index.js`).

## تشغيل محلي (لو عندك كمبيوتر)
```bash
node index.js     # يفتح على http://localhost:7000
```
