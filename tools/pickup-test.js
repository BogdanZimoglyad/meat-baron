/* Тест справжнього коду: вирізаємо pickupSweep із server.js і запускаємо
   з підставленими db, bot і годинником. */
const fs=require('fs');
const src=fs.readFileSync('server.js','utf8');
const m=src.match(/function pickupSweep\(\) \{[\s\S]*?\n\}/);
if(!m) { console.error('pickupSweep не знайдено'); process.exit(1) }

const MIN=60000;
let sent=[];
const mkEnv=(orders,hour)=>({
  db:{orders,users:{'661234567':{tgId:777}}},
  kyivNow:()=>{const d=new Date(); d.setHours(hour,30,0,0); return d},
  OPEN_HOUR:8, PICKUP_EVERY:600000, PICKUP_MAX:6, PICKUP_TELL_SHOP:3,
  save:()=>{},
  SITE:'https://x/',
  bot:{sendMessage:(chat,text)=>{sent.push({chat,text:text.slice(0,60)});return Promise.resolve()}},
  console:{warn:()=>{}}
});
function run(orders,hour=14){
  sent=[];
  const env=mkEnv(orders,hour);
  const fn=new Function(...Object.keys(env),`${m[0]}; return pickupSweep()`);
  fn(...Object.values(env));
  return sent;
}
const base=(over={})=>({no:1,mode:'pickup',status:'ready',telKey:'661234567',tel:'+380661234567',
  shopName:'Шевченка',chatId:-100,msgId:5,readyAt:Date.now()-15*MIN,slotAt:0,...over});

const t=[];
t.push(['готове 15 хв тому → нагадали клієнту', run({1:base()}).length===1]);
t.push(['слот через годину → мовчимо', run({1:base({slotAt:Date.now()+60*MIN})}).length===0]);
t.push(['щойно готове → мовчимо', run({1:base({readyAt:Date.now()-2*MIN})}).length===0]);
t.push(['уже 6 нагадувань → мовчимо', run({1:base({pickN:6})}).length===0]);
t.push(['третє нагадування → ще й точці', run({1:base({pickN:2,pickAt:Date.now()-11*MIN})}).length===2]);
t.push(['сказав «вже їду» → пауза', run({1:base({pickPause:Date.now()+20*MIN})}).length===0]);
t.push(['після паузи → знову нагадуємо', run({1:base({pickPause:Date.now()-MIN})}).length===1]);
t.push(['натиснув «не нагадувати» → тиша', run({1:base({pickN:6,pickQuiet:true})}).length===0]);
t.push(['доставка → не чіпаємо', run({1:base({mode:'delivery'})}).length===0]);
t.push(['уже видано → не чіпаємо', run({1:base({status:'done'})}).length===0]);
t.push(['після закриття (21:30) → мовчимо', run({1:base()},21).length===0]);
t.push(['без Telegram → одразу кажемо точці', run({1:base({telKey:'999999999'})}).map(s=>s.chat)[0]===-100]);

let bad=0;
for(const [name,ok] of t){ console.log((ok?'  ok  ':'ПАДАЄ') + ' · ' + name); if(!ok) bad++ }
console.log(bad? `\n${bad} з ${t.length} не пройшло` : `\nусі ${t.length} сценарії пройшли`);
process.exit(bad?1:0);
