#!/usr/bin/env node
/**
 * City Pulse - Data Collector
 * Fetches urban metrics data and saves to JSON files
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');
const HISTORY_DIR = path.join(DATA_DIR, 'history');

// Fetch HTML using curl (more reliable for Chinese sites)
function fetchHTML(url) {
  try {
    const html = execSync(`curl -s '${url}' -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'`, {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024
    });
    return html;
  } catch (error) {
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

// Parse price value from text
function parsePrice(text) {
  const cleaned = text.replace(/[,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Extract data from fangjia.fang.com HTML
function parseFangjiaHTML(html) {
  const data = {
    updatedAt: new Date().toISOString(),
    city: '上海',
    metrics: {
      resale: { avgPrice: null, unit: '元/平米', change: null },
      new: { avgPrice: null, unit: '元/平米', change: null }
    },
    districts: [],
    newProperties: [],
    resaleProperties: []
  };

  // Extract resale average price
  const resaleMatch = html.match(/二月二手房参考均价[\s\S]*?<span>\s*(\d[\d,]*)\s*<\/span>\s*元\/平/);
  if (resaleMatch) {
    data.metrics.resale.avgPrice = parsePrice(resaleMatch[1]);
  }

  // Extract new home average price and change
  const newMatch = html.match(/二月新房参考均价[\s\S]*?<span>(\d[\d,]*)<\/span>\s*元\/平[\s\S]*?比上月(下跌|上涨)(\d+\.?\d*)%/);
  if (newMatch) {
    data.metrics.new.avgPrice = parsePrice(newMatch[1]);
    const change = parseFloat(newMatch[3]);
    data.metrics.new.change = newMatch[2] === '下跌' ? -change : change;
  }

  // Extract ALL district prices from "上海二手房区县房价榜" section
  // Format: <a href="/sh/a024/" target="_blank">黄浦</a><span class="pm-price">99502元/平</span>
  // Followed by: <span>环比上月</span><span class="f12 pm-rate"> 0.72% <i ...>↓</i></span>
  
  const allDistricts = [
    '黄浦', '徐汇', '静安', '长宁', '虹口', '普陀', '杨浦', '闵行', '浦东', 
    '青浦', '宝山', '嘉定', '松江', '奉贤', '金山', '崇明'
  ];
  
  // Match pattern for each district
  for (const district of allDistricts) {
    const pattern = new RegExp(
      `<a href="/sh/a\\d+/"[^>]*>${district}</a><span class="pm-price">(\\d[\\d,]*)元/平</span>[\\s\\S]*?` +
      `<span>环比上月</span><span class="f12 pm-rate">[\\s]*(\\d+\\.?\\d*)%[\\s]*<i[^>]*>(↓|↑)</i>`,
      'g'
    );
    
    const match = pattern.exec(html);
    if (match) {
      const price = parsePrice(match[1]);
      const changeVal = parseFloat(match[2]);
      const change = match[3] === '↓' ? -changeVal : changeVal;
      
      if (price) {
        data.districts.push({ name: district, price, change });
      }
    }
  }

  // Extract new property listings
  // Format: <a href="https://sh.newhouse.fang.com/loupan/XXX.htm"...>区域 - 楼盘名</a>
  //         <span class="price">XXX元/m²</span>
  //         <em>户型信息</em>
  const newPropPattern = /<a href="(https:\/\/sh\.newhouse\.fang\.com\/loupan\/\d+\.htm)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<span class="price">(\d[\d,]*)元\/m[²²]/g;
  
  let propMatch;
  const seenProps = new Set();
  
  while ((propMatch = newPropPattern.exec(html)) !== null) {
    const url = propMatch[1];
    const location = propMatch[2].trim();
    const price = parsePrice(propMatch[3]);
    
    if (price && !seenProps.has(url)) {
      seenProps.add(url);
      
      // Extract layout info
      const layoutMatch = html.slice(propMatch.index, propMatch.index + 500).match(/<em>([^<]+)<\/em>/);
      const layout = layoutMatch ? layoutMatch[1].trim() : '';
      
      data.newProperties.push({ location, url, price, layout });
    }
  }

  return data;
}

// Fetch resale properties for specific areas
async function fetchResaleProperties() {
  const properties = [];
  
  // Areas to fetch: 新江湾城 (杨浦), 内环, 中环
  const areas = [
    { url: 'https://sh.esf.fang.com/house-a026-b01651/', name: '新江湾城', district: '杨浦' },
    { url: 'https://sh.esf.fang.com/house-a025/', name: '内环', district: '浦东' }
  ];
  
  for (const area of areas) {
    try {
      console.log(`   Fetching ${area.name}...`);
      const html = fetchHTML(area.url);
      
      // Parse property listings
      // Format: <a href="//sh.esf.fang.com/chushou/3_XXX.htm"...>楼盘名</a>
      //         <span class="price"><b>XXX</b>万</span>
      //         <em>X室X厅/XXX㎡</em>
      
      const propPattern = /<a href="(\/\/sh\.esf\.fang\.com\/chushou\/[^"]+)"[^>]*title="[^"]*"[^>]*>([^<]+)<\/a>[\s\S]*?<span class="price"><b>(\d+)<\/b>万<\/span>[\s\S]*?<em>(\d室\d厅\/[\d.]+㎡)/g;
      
      let match;
      let count = 0;
      
      while ((match = propPattern.exec(html)) !== null && count < 5) {
        const url = 'https:' + match[1];
        const name = match[2].trim();
        const totalPrice = parseInt(match[3]);
        const layout = match[4];
        
        // 只保留700万以下的
        if (totalPrice <= 700) {
          // 计算单价
          const areaMatch = layout.match(/([\d.]+)㎡/);
          const areaSize = areaMatch ? parseFloat(areaMatch[1]) : 0;
          const unitPrice = areaSize > 0 ? Math.round(totalPrice * 10000 / areaSize) : null;
          
          properties.push({
            name,
            url,
            totalPrice,
            unitPrice,
            layout,
            district: area.district,
            area: area.name
          });
        }
        count++;
      }
      
    } catch (error) {
      console.error(`   ⚠️ Failed to fetch ${area.name}: ${error.message}`);
    }
  }
  
  return properties;
}

// Main function
async function main() {
  console.log('🏙️ City Pulse - Data Collector');
  console.log('==============================\n');

  try {
    // Fetch main data
    console.log('📡 Fetching main data...');
    const html = fetchHTML('https://fangjia.fang.com/sh/');
    console.log(`   Received ${html.length} bytes\n`);

    // Parse data
    console.log('🔍 Parsing data...');
    const data = parseFangjiaHTML(html);
    
    // Fetch resale properties
    console.log('📡 Fetching resale properties (<700万)...');
    const resaleProps = await fetchResaleProperties();
    data.resaleProperties = resaleProps;
    console.log(`   Found ${resaleProps.length} properties\n`);
    
    // Display results
    console.log('\n📊 Results:');
    console.log(`   Updated: ${data.updatedAt}`);
    console.log(`   Resale avg: ${data.metrics.resale.avgPrice?.toLocaleString() || 'N/A'} ${data.metrics.resale.unit}`);
    console.log(`   New avg: ${data.metrics.new.avgPrice?.toLocaleString() || 'N/A'} ${data.metrics.new.unit} (${data.metrics.new.change || 'N/A'}%)`);
    console.log(`   Districts: ${data.districts.length}`);
    
    if (data.districts.length > 0) {
      console.log('\n   所有区县房价:');
      data.districts.sort((a, b) => b.price - a.price).forEach((d, i) => {
        const changeStr = d.change !== null ? ` (${d.change > 0 ? '+' : ''}${d.change}%)` : '';
        console.log(`   ${(i + 1).toString().padStart(2)}. ${d.name}: ${d.price.toLocaleString()} 元/平米${changeStr}`);
      });
    }

    if (data.newProperties.length > 0) {
      console.log('\n   新房推荐:');
      data.newProperties.slice(0, 5).forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.location}: ${p.price.toLocaleString()} 元/㎡ - ${p.layout}`);
      });
    }

    if (data.resaleProperties.length > 0) {
      console.log('\n   二手房推荐 (<700万):');
      data.resaleProperties.forEach((p, i) => {
        console.log(`   ${i + 1}. [${p.area}] ${p.name}: ${p.totalPrice}万 (${p.unitPrice?.toLocaleString()}元/㎡) - ${p.layout}`);
      });
    }

    // Ensure directories exist
    if (!fs.existsSync(HISTORY_DIR)) {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
    }

    // Save latest data
    console.log('\n💾 Saving data...');
    fs.writeFileSync(LATEST_FILE, JSON.stringify(data, null, 2));
    console.log(`   ✅ Saved to ${LATEST_FILE}`);

    // Save to history
    const today = new Date().toISOString().split('T')[0];
    const historyFile = path.join(HISTORY_DIR, `${today}.json`);
    fs.writeFileSync(historyFile, JSON.stringify(data, null, 2));
    console.log(`   ✅ Saved to ${historyFile}`);

    console.log('\n✨ Done!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();
