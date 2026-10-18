const { chromium } = require('/tmp/e2epw/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const cases = require('./cases.json');
const out = path.join(__dirname, 'fixtures'); fs.mkdirSync(out, { recursive: true });
const card = (c, blur) => `<html><body style="margin:0;background:#ddd;font-family:Helvetica">
<div style="width:640px;height:400px;margin:20px;background:#fff;border-radius:18px;box-shadow:0 2px 8px #0003;padding:28px;box-sizing:border-box;position:relative;filter:blur(${blur||0}px)">
<div style="font-size:13px;color:#b00;letter-spacing:2px">SYNTHETIC TEST DOCUMENT</div>
<div style="font-size:24px;font-weight:bold;color:#123;margin-top:6px">${c.issuer}</div>
<div style="font-size:15px;color:#555">Membership Card 2026–2027</div>
<div style="margin-top:34px;font-size:13px;color:#777">MEMBER</div><div style="font-size:26px">${c.name}</div>
<div style="margin-top:14px;font-size:13px;color:#777">CERTIFICATION</div><div style="font-size:20px">${c.level}</div>
<div style="margin-top:14px;font-size:13px;color:#777">MEMBER #</div><div style="font-size:18px">104-2231</div>
<div style="position:absolute;right:28px;bottom:70px;text-align:right"><div style="font-size:13px;color:#777">VALID THROUGH</div><div style="font-size:20px">${c.validThrough}</div>
${c.overlay ? `<div style="position:absolute;right:-4px;top:16px;background:#fff;font-family:'Courier New';font-size:19px;padding:0 4px">${c.overlay}</div>` : ''}</div>
${c.footer ? `<div style="position:absolute;left:28px;bottom:14px;font-size:10px;color:#999;width:580px">${c.footer}</div>` : ''}
</div></body></html>`;
const receipt = `<html><body style="font-family:monospace;padding:30px;width:400px">SYNTHETIC TEST DOCUMENT<br><br>WHISTLER COFFEE CO.<br>2026-10-01 08:14<br><br>Latte grande ..... 6.25<br>Croissant ........ 4.10<br><br>TOTAL ........... 10.35<br>VISA ****1123</body></html>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 700, height: 460 } });
  for (const c of cases) {
    await p.setContent(c.receipt ? receipt : card(c.card, c.blur));
    if (c.pdf) { await p.pdf({ path: path.join(out, `${c.id}.pdf`), width: '700px', height: '460px', printBackground: true }); }
    else { await p.screenshot({ path: path.join(out, `${c.id}.png`) }); }
  }
  await b.close(); console.log('fixtures:', fs.readdirSync(out).length);
})();
