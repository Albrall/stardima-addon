# 🌟 كرتون زمان | Krtoon Zaman — Stremio & Nuvio Addon

[![Version](https://img.shields.io/badge/version-v3.10.1-blue.svg)](https://github.com/Albrall/stardima-addon/releases)
[![Cloudflare Workers](https://img.shields.io/badge/deployed_on-Cloudflare_Workers-orange.svg)](https://workers.cloudflare.com)
[![CI/CD](https://github.com/Albrall/stardima-addon/actions/workflows/deploy.yml/badge.svg)](https://github.com/Albrall/stardima-addon/actions/workflows/deploy.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-green.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

إضافة مخصصة لمشغلات **Stremio** و **Nuvio** لعرض وتشغيل مسلسلات وأفلام الكرتون والأنمي المدبلجة والمترجمة للعربية مباشرة وبدون إعلانات، مستندة إلى مكتبة ضخمة وأداء فائق السرعة عبر شبكة Cloudflare السحابية.

---

## 🚀 التثبيت السريع (Quick Install)

يمكنك تثبيت الإضافة مباشرة في تطبيق Stremio أو Nuvio:

| الطريقة | الرابط / الإجراء |
| :--- | :--- |
| **تثبيت مباشر بنقرة واحدة** | [اضغط هنا للتثبيت في Stremio](stremio://krtoonzaman.albranmaze7.workers.dev/manifest.json) |
| **رابط المانفست المباشر (Manifest URL)** | `https://krtoonzaman.albranmaze7.workers.dev/manifest.json` |

> 💡 **وضع التقسيم للأجهزة القديمة (Chunked Mode):**  
> إذا كنت تستخدم جهاز تلفزيون قديم أو شاشة بمواصفات متواضعة تواجه صعوبة في تحميل القوائم الكاملة، يمكنك استخدام رابط وضع التقسيم:  
> `https://krtoonzaman.albranmaze7.workers.dev/manifest.json?mode=chunked`

---

## ✨ المميزات الرئيسية (Key Features)

- ⚡ **بحث فائق السرعة (< 1 ثانية):** استجابة فورية للبحث باللغة العربية مع معالجة ذكية للحروف (مثل توحيد أ، إ، آ، ى، هـ، ة) وتصفية النتائج بدقة.
- 📺 **تقديم وترجيع سلس على الشاشات والتلفزيون (Smooth Seeking):** دعم كامل لطلبات `Range` وإعادة التوجيه المباشر `HTTP 307` لملفات MP4 لتفادي بطء المشغل أو إعادة فك الروابط عند التقديم والترجيع.
- 📚 **مكتبة كرتون ضخمة:** أكثر من **2250+ مسلسل** وأكثر من **1590+ فيلم** كرتون وأنيمي كلاسيكي وحديث.
- 🎯 **تصنيفات وفلاتر منوعة:** تصفح حسب التصنيف (أكشن، مغامرات، كوميديا، خيال علمي، كلاسيكيات قبل عام 2000، وغيرها) بالإضافة إلى قوائم (الأحدث، العرض اليومي، HD، والأعلى مشاهدة).
- 🎬 **دقة عالية ومصادر متعددة:** فحص لحظي ومستمر لسيرفرات التشغيل لتقديم السيرفر الأسرع والأنسب، مع دعم أعمال مختارة بجودة Full HD 1080p عبر مصدر جي كرتون (`jcartoon`).
- 🛡️ **أمان واستقرار عالي:** وكيل وسائط (Proxy) محمي بنظام النطاقات المسموحة (Allowlist) لمنع الاستغلال، مع إدارة ذكية للذاكرة المخبأة (LRU Cache).
- 🔄 **نشر سحابي وتحديثات آلية (CI/CD):** بمجرد دمج التعديلات في فرع `main`، تقوم خوادم GitHub Actions باختبار الأكواد، وبناء الحزمة، وتحديث Cloudflare Workers تلقائياً مع إصدار نسخة GitHub Release جديدة.

---

## 📂 القوائم والكتالوجات (Catalogs)

| الكتالوج | المعرف (ID) | الوصف |
| :--- | :--- | :--- |
| **🔥 أحدث المسلسلات / الأفلام** | `stardima-new` / `stardima-new-movies` | جديد الإضافات والحلقات أولاً بأول |
| **⭐ الأكثر شهرة وتقييماً** | `stardima-top` / `stardima-top-movies` | الأعمال الأعلى تقييماً والأكثر متابعة |
| **📺 كواكب سبيستون والزهرة** | `stardima-spacetoon` | كافة أعمال ومسلسلات سبيستون وسبيس باور والزهرة |
| **⏳ كرتون الطيبين (كلاسيك)** | `stardima-classic` / `stardima-classic-movies` | مسلسلات وأفلام الزمن الجميل والعصر الذهبي (قبل 2005) |
| **🎲 اقتراحات اليوم** | `stardima-daily` / `stardima-daily-movies` | ترشيحات ذكية متجددة يومياً حسب ثيمات مختارة |
| **📚 كل المسلسلات / الأفلام (أ-ي)** | `stardima` / `stardima-movies` | المكتبة الكاملة مع دعم البحث وفلاتر التصنيف والجودة |
| **💎 جودة عالية 720p+** | `stardima-hd` / `stardima-hd-movies` | أعمال بجودة عالية تتضمن نسخ Full HD 1080p |

---

## 🛠️ التطوير المحلي والاختبار (Local Development)

المشروع مصمم ليعمل بدون حزم تشغيل إضافية ثقيلة (Zero runtime dependencies).

### 1. تشغيل السيرفر محلياً
```bash
node serve-worker.js
```
سيبدأ الخادم المحلي بالعمل على: `http://localhost:7000/manifest.json`.

### 2. تشغيل الاختبارات الآلية (Unit Tests)
```bash
npm test
```
يقوم بفحص تلقائي لتطبيع النصوص العربية، ترتيب الحروف الأبجدية، فك التشفير عن مشغلات الفيديو، والتحقق من صحة مسارات الـ Worker.

### 3. بناء ملف العامل (Worker Bundle)
```bash
node src/build-worker.js
```
يتم دمج ملفات `src/` مع الفهرس وإنشاء ملف الحزمة الجاهز للنشر `worker-addon.js`.

---

## 🚢 النشر السحابي (Deployment)

### النشر التلقائي عبر GitHub Actions (موصى به)
المشروع مضبوط بالكامل للنشر الآلي بمجرد الرفع إلى فرع `main`:
1. تشغيل الاختبارات والتأكد من سلامة الكود (`npm test`).
2. تجميع وبناء ملف العامل (`worker-addon.js`).
3. النشر إلى Cloudflare Workers عبر `wrangler`.
4. إصدار نسخة جديدة وتحديث سجل التغييرات في GitHub Releases.

> **المتغيرات السرية المطلوبة (Repository Secrets):**
> - `CF_API_TOKEN` أو `CF_API_TOKEN2`: توكن الوصول لـ Cloudflare Workers.
> - `CF_ACCOUNT_ID` أو `CF_ACCOUNT_ID2`: معرّف حساب Cloudflare الخاص بك.

### النشر عبر الحاويات (Docker & Self-Hosted)
يمكن أيضاً تشغيل الإضافة كحاوية Docker مستقلة على أي سيرفر أو خدمة مثل ElfHosted:
```bash
docker build -t krtoon-zaman .
docker run -d -p 8000:8000 --name krtoon-zaman krtoon-zaman
```
لمزيد من التفاصيل حول استضافة الحاويات راجع [ELFHOSTED.md](ELFHOSTED.md).

---

## 📋 هيكلة المشروع (Repository Structure)

```text
├── .github/workflows/    # مسارات النشر الآلي والفحص اليومي
├── src/
│   ├── worker-router.js  # محرك المسارات والمناول لـ Cloudflare Worker
│   ├── lib/
│   │   ├── stardima.js   # الربط مع الموقع، البحث، وجلب الحلقات
│   │   ├── resolver.js   # استخراج الروابط وترتيب السيرفرات حسب استجابتها
│   │   ├── hosts.js      # التعامل مع السيرفرات وفك المشغلات المشفرة
│   │   └── unpacker.js   # فك شفرة Dean Edwards بدون الحاجة لـ eval
│   └── build-worker.js   # سكريبت بناء وتجميع ملف العامل
├── tools/
│   └── unit-test.js      # حزمة الاختبارات الآلية الشاملة
├── worker-addon.js       # ملف العامل النهائي المجمع للنشر السحابي
├── serve-worker.js       # سيرفر Node.js للتشغيل والتطوير المحلي
├── CHANGELOG.md          # سجل التحديثات والإصدارات
└── package.json
```

---

## 📄 سجل التغييرات (Changelog)

لمعرفة تفاصيل كافة التحسينات والإصدارات السابقة، يرجى مراجعة [CHANGELOG.md](CHANGELOG.md).

---

## ⚖️ الترخيص (License)

هذا المشروع منشور تحت رخصة [MIT License](LICENSE).
