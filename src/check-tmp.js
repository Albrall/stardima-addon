const {getJson,BASE}=require('./lib/stardima');
(async()=>{
  let lens=[], empty=0, n=0;
  for (const ep of ['mosalsalat','aflam']) for (const p of [1,2,40]) {
    const j=await getJson(BASE+'/'+ep+'?page='+p);
    for (const v of (j.videos||[])) { n++; const d=(v.description||'').trim(); if(!d) empty++; else lens.push(d.length); }
  }
  lens.sort((a,b)=>a-b);
  console.log('  items sampled:', n, '| empty descriptions:', empty);
  console.log('  desc length: min', lens[0], '| median', lens[Math.floor(lens.length/2)], '| max', lens[lens.length-1]);
  const j=await getJson(BASE+'/mosalsalat?page=1');
  (j.videos||[]).slice(0,6).forEach(v=>console.log('  •',(v.title||'').slice(0,26),'::',(v.description||'').slice(0,130).replace(/\n/g,' ')));
})();
