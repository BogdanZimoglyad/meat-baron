/* Звідки прийшли (01.10): як головна визначає джерело — мітка ?from=,
   сайт-попередник, сторінка товару t/, «з іконки», остання мітка за 7 днів.
   Функції вирізаємо з index.html і ганяємо на підставлених адресах.
   Запуск: npm test */
const fs=require('fs');
const report = require('../report.js');
const html=fs.readFileSync(require('path').join(__dirname,'..', '..','index.html'),'utf8').replace(/\r\n/g,'\n');
const code=html.match(/const SRC_TAGS=[\s\S]*?\nconst hit=/)[0].replace(/\nconst hit=$/,'');
function run({url,ref,store={},local={},screen=false}){
  const u=new URL(url); let replaced=null;
  const ss={getItem:k=>store[k]??null,setItem:(k,v)=>store[k]=v};
  const ls={getItem:k=>local[k]??null,setItem:(k,v)=>local[k]=v};
  const loc={search:u.search,hostname:u.hostname,pathname:u.pathname,hash:u.hash};
  const f=new Function('location','document','sessionStorage','localStorage','history','onScreen','URL','URLSearchParams',code+';return {v:visitSrc(),o:orderSrc()}');
  const r=f(loc,{referrer:ref||''},ss,ls,{state:null,replaceState:(a,b,c)=>replaced=c},()=>screen,URL,URLSearchParams);
  return {...r,replaced,local};
}
const H='https://meat-baron.kh.ua';
const cases=[
 ['мітка igs, прибрана з адреси', run({url:H+'/?from=igs'}), r=>r.v==='igs'&&r.replaced==='/'],
 ['мітка + товар: товар лишився', run({url:H+'/?item=i1&from=tt'}), r=>r.v==='tt'&&r.replaced==='/?item=i1'],
 ['qr3', run({url:H+'/?from=qr3'}), r=>r.v==='qr3'],
 ['сміттєва мітка → напряму', run({url:H+'/?from=evil'}), r=>r.v==='direct'],
 ['Google', run({url:H+'/',ref:'https://www.google.com.ua/'}), r=>r.v==='google'],
 ['Instagram без мітки', run({url:H+'/',ref:'https://l.instagram.com/'}), r=>r.v==='ig'],
 ['Telegram', run({url:H+'/',ref:'https://t.me/'}), r=>r.v==='tg'],
 ['інший сайт', run({url:H+'/',ref:'https://olx.ua/'}), r=>r.v==='site'],
 ['з іконки', run({url:H+'/',screen:true}), r=>r.v==='app'],
 ['через сторінку товару з Google', run({url:H+'/?item=i1',ref:H+'/t/i1.html',store:{'mb-ref':'https://www.google.com/'}}), r=>r.v==='google'],
 ['замовлення: напряму, але вчора був Instagram', run({url:H+'/',local:{'mb-src-last':JSON.stringify({s:'ig',at:Date.now()-864e5})}}), r=>r.v==='direct'&&r.o==='ig'],
 ['мітка старша 7 днів не діє', run({url:H+'/',local:{'mb-src-last':JSON.stringify({s:'ig',at:Date.now()-8*864e5})}}), r=>r.o==='direct'],
 ['напряму не перетирає останню мітку', run({url:H+'/',local:{'mb-src-last':'{"s":"tt","at":1}'}}), r=>r.local['mb-src-last']==='{"s":"tt","at":1}'],
];
report(cases.map(([n,r,ok])=>[n,ok(r)]));
