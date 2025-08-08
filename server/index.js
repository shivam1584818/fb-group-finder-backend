const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const pLimit = require('p-limit');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// CONFIG: set via env or edit here
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENCY = 3; // tabs concurrently
const SCAN_LIMIT = 300; // max groups to visit per request
const LOGIN_EMAIL = process.env.FB_EMAIL || ''; // optional
const LOGIN_PASSWORD = process.env.FB_PASS || ''; // optional

// Simple API key middleware (optional)
const API_KEY = process.env.API_KEY || '';
app.use((req,res,next)=>{
  if(API_KEY){
    const k = req.headers['x-api-key'] || '';
    if(k !== API_KEY) return res.status(401).json({ message: 'Invalid API key' });
  }
  next();
});

// Helper to extract group links from facebook search/groups page HTML (best-effort)
function extractGroupLinks(html){
  const re = /href=\\"(https:\\/\\/www.facebook.com\\/groups\\/[^\\"\\s>]+)\\"[^>]*>([^<]{2,140})/gi;
  const out = new Map();
  let m;
  while((m = re.exec(html)) !== null){
    const link = m[1].replace(/&amp;/g,'&').replace(/\\/g,'').trim();
    const name = m[2].replace(/<[^>]*>/g,'').trim();
    if(!out.has(link)) out.set(link, { link, name });
  }
  return Array.from(out.values());
}

app.post('/scan', async (req, res) => {
  const { postUrl } = req.body;
  if(!postUrl) return res.status(400).json({ message: 'postUrl required' });
  let browser;
  try{
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    // If login provided, sign in to Facebook to see private groups
    if(process.env.FB_EMAIL && process.env.FB_PASS){
      await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' });
      await page.fill('input[name=email]', process.env.FB_EMAIL);
      await page.fill('input[name=pass]', process.env.FB_PASS);
      await page.click('button[name=login]');
      await page.waitForTimeout(3000);
    }
    // 1) Use Facebook search for the post URL (site search)
    const searchUrl = 'https://www.facebook.com/search/groups/?q=' + encodeURIComponent(postUrl);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const html = await page.content();
    let groups = extractGroupLinks(html);
    // If none found, try a broader search by post id or keywords
    if(groups.length === 0){
      // try searching groups for keywords from the URL (last segment)
      const parts = postUrl.split('/').filter(Boolean);
      const last = parts[parts.length-1] || postUrl;
      const searchUrl2 = 'https://www.facebook.com/search/groups/?q=' + encodeURIComponent(last);
      await page.goto(searchUrl2, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      const html2 = await page.content();
      groups = extractGroupLinks(html2);
    }
    // cap groups
    groups = groups.slice(0, SCAN_LIMIT);
    const limit = pLimit(MAX_CONCURRENCY);
    const results = [];
    // visit each group and search for the exact postUrl in rendered content
    await Promise.all(groups.map(g => limit(async () => {
      try{
        const pg = await context.newPage();
        await pg.goto(g.link, { waitUntil: 'domcontentloaded' });
        await pg.waitForTimeout(2000);
        const body = await pg.content();
        const found = body.includes(postUrl) || body.includes(encodeURI(postUrl));
        const auto = body.toLowerCase().includes('auto') && body.toLowerCase().includes('approve');
        results.push({ name: g.name, link: g.link, found, auto });
        await pg.close();
      }catch(e){
        results.push({ name: g.name, link: g.link, error: e.message });
      }
    })));
    await browser.close();
    // return groups where found == true OR include all groups optionally
    const foundGroups = results.filter(r => r.found).map(r => ({ name: r.name, link: r.link, auto: !!r.auto }));
    return res.json({ groups: foundGroups, scanned: results.length });
  }catch(e){
    if(browser) await browser.close().catch(()=>{});
    return res.status(500).json({ message: e.message });
  }
});

app.listen(PORT, ()=> console.log('Server listening on', PORT));
