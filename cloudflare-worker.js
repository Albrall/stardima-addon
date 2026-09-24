// ============================================================
// خطة ب: وسيط Cloudflare Worker لستارديما
// ============================================================
// ليش؟ ستارديما يحظر نطاق IPs حق Render (403). الـ Worker يشتغل على حافة
// Cloudflare (IP نظيف) ويجيب ستارديما نيابة عن الأدئون.
//
// الطريقة (مرة وحدة):
// 1) افتح dash.cloudflare.com ← سجّل/ادخل (مجاني).
// 2) القائمة اليسرى: Workers & Pages ← Create ← Hello World worker ← اسمها stardima-proxy.
// 3) احذف الكود التجريبي والصق الكود تحت بالكامل ← Save & Deploy.
// 4) انسخ رابط الـ worker (شكله: https://stardima-proxy.<حسابك>.workers.dev).
// 5) في Render: خدمتك stardima ← Environment ← Add:
//        Key:   STARDIMA_BASE
//        Value: https://stardima-proxy.<حسابك>.workers.dev
//    ← Save (يعيد النشر تلقائيًا).
// 6) خلص — الأدئون الحين يجيب ستارديما عبر الـ worker.
// ============================================================
export default {
  async fetch(request) {
    const REAL = 'https://stardima-s7.cartoon.com.im';
    const url = new URL(request.url);
    const target = REAL + url.pathname + url.search;

    const headers = new Headers();
    for (const k of ['accept', 'accept-language', 'x-requested-with']) {
      const v = request.headers.get(k);
      if (v) headers.set(k, v);
    }
    headers.set('user-agent', request.headers.get('user-agent') ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    headers.set('referer', REAL + '/');

    try {
      const upstream = await fetch(target, { headers, redirect: 'follow' });
      const body = await upstream.arrayBuffer();
      return new Response(body, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      return new Response('proxy error: ' + e.message, { status: 502 });
    }
  },
};
