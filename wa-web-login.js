#!/usr/bin/env node
/**
 * WhatsApp Web Auto Login - Real Automation Script
 * يفتح واتساب ويب ويختار "Link with phone number" ويكتب الرقم
 */

const puppeteer = require('puppeteer');

// الألوان للـ terminal
const c = {
    r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m',
    m: '\x1b[35m', cy: '\x1b[36m', w: '\x1b[37m', x: '\x1b[0m',
    bold: '\x1b[1m', dim: '\x1b[2m'
};

function log(msg, color = 'w') {
    console.log(c[color] + msg + c.x);
}
function banner() {
    console.clear();
    log(c.cy + c.bold + '╔═══════════════════════════════════════════╗' + c.x);
    log(c.cy + c.bold + '║  📱 WhatsApp Web Auto Login               ║' + c.x);
    log(c.cy + c.bold + '║  🤖 Real Automation Script                ║' + c.x);
    log(c.cy + c.bold + '╚═══════════════════════════════════════════╝' + c.x + '\n');
}

// انتظار عشوائي بين قيمتين
function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function humanType(page, selector, text) {
    // كتابة بسرعة بشرية
    const el = await page.$(selector);
    if (!el) throw new Error('Element not found: ' + selector);
    await el.click();
    await sleep(300);
    for (const char of text) {
        await page.keyboard.type(char, { delay: rand(50, 150) });
    }
}

async function findAndClick(page, searchTexts) {
    // يدور على زرار بنص معين ويضغطه
    return await page.evaluate((texts) => {
        const elements = document.querySelectorAll('div[role="button"], button, a, span');
        for (const el of elements) {
            const text = (el.textContent || '').toLowerCase().trim();
            for (const search of texts) {
                if (text.includes(search.toLowerCase())) {
                    // اضغط على أقرب div[role="button"] أو الزرار نفسه
                    let target = el;
                    while (target && target.getAttribute) {
                        if (target.getAttribute('role') === 'button' || target.tagName === 'BUTTON') {
                            target.click();
                            return { found: true, text: text.substring(0, 50) };
                        }
                        target = target.parentElement;
                    }
                    el.click();
                    return { found: true, text: text.substring(0, 50) };
                }
            }
        }
        return { found: false };
    }, searchTexts);
}

async function findPhoneInput(page) {
    // يدور على خانة الرقم
    return await page.evaluate(() => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
            const type = input.getAttribute('type') || '';
            const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
            const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
            if (type === 'tel' || 
                placeholder.includes('phone') || 
                placeholder.includes('رقم') ||
                ariaLabel.includes('phone') ||
                ariaLabel.includes('number')) {
                return { found: true, id: input.id, name: input.name };
            }
        }
        // fallback: أول input فاضي
        for (const input of inputs) {
            if (!input.value && input.type !== 'hidden' && input.type !== 'checkbox') {
                return { found: true, id: input.id, name: input.name };
            }
        }
        return { found: false };
    });
}

async function readCode(page) {
    // يدور على كود 8 حروف (مثال: ABCD-EFGH)
    return await page.evaluate(() => {
        const all = document.querySelectorAll('div, span, p, h1, h2');
        const results = [];
        for (const el of all) {
            if (el.children.length > 0) continue;
            const text = (el.textContent || '').trim();
            const match = text.match(/^([A-Z0-9]{4})-([A-Z0-9]{4})$/);
            if (match) {
                results.push(text);
            }
        }
        return results[0] || null;
    });
}

async function readPageError(page) {
    // يقرأ أي رسالة خطأ
    return await page.evaluate(() => {
        const selectors = ['div[role="dialog"]', 'div[role="alert"]', 'div[data-animate-modal-body]'];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent) {
                return el.textContent.trim().substring(0, 200);
            }
        }
        return null;
    });
}

async function main() {
    banner();
    
    // ═══ 1) قراءة الرقم ═══
    const phone = process.argv[2] || '';
    if (!phone) {
        log('❌ استخدم: node wa-web-login.js 201012345678', 'r');
        process.exit(1);
    }
    const cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length < 10) {
        log('❌ الرقم لازم يكون بالصيغة الدولية (مثال: 201012345678)', 'r');
        process.exit(1);
    }
    
    log('📱 الرقم: ' + c.bold + cleanPhone + c.x, 'cy');
    log('🌐 فتح المتصفح...\n', 'y');

    // ═══ 2) تشغيل المتصفح ═══
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: false,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/data/data/com.termux/files/usr/bin/chromium-browser',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--window-size=400,800',
                '--user-agent=Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
            ],
            defaultViewport: { width: 400, height: 800 }
        });
    } catch (e) {
        log('❌ فشل تشغيل المتصفح: ' + e.message, 'r');
        log('', 'x');
        log('💡 تأكد من تثبيت chromium:', 'y');
        log('   pkg install chromium', 'cy');
        process.exit(1);
    }

    const page = await browser.newPage();
    
    // ═══ 3) اخفاء مؤشرات البوت ═══
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['ar-SA', 'ar', 'en-US', 'en'] });
        window.chrome = { runtime: {} };
    });

    // ═══ 4) تفعيل logging ═══
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('error') || text.includes('Error')) {
            log('  [PAGE] ' + text.substring(0, 100), 'r');
        }
    });

    // ═══ 5) روح لواتساب ويب ═══
    log('⏳ انتظار تحميل الصفحة...', 'y');
    try {
        await page.goto('https://web.whatsapp.com', {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });
    } catch (e) {
        log('⚠️ timeout في التحميل — بنكمل...', 'y');
    }
    
    // انتظر تحميل كامل
    log('⏳ انتظار 8 ثواني للتحميل الكامل...', 'y');
    await sleep(8000);

    // ═══ 6) ابحث عن زر "Link with phone number" ═══
    log('\n🔍 البحث عن زر "Link with phone number"...', 'cy');
    
    let clicked = false;
    for (let attempt = 0; attempt < 5; attempt++) {
        const result = await findAndClick(page, [
            'link with phone number',
            'link with phone',
            'log in with phone number',
            'with phone number',
            'use phone number',
            'رقم الهاتف',
            'الاتصال برقم'
        ]);
        
        if (result.found) {
            log('✅ تم الضغط على: ' + result.text, 'g');
            clicked = true;
            break;
        }
        
        log('  محاولة ' + (attempt+1) + '/5... لم يُوجد', 'dim');
        await sleep(2000);
    }
    
    if (!clicked) {
        log('⚠️ مش لاقي الزر — الصفحة يمكن بالعربي/إنجليزي مختلف', 'y');
        log('💡 هنجرب ندوس على أي زر في الصفحة', 'y');
        // جرب أي زر
        await page.evaluate(() => {
            const btn = document.querySelector('div[role="button"], button');
            if (btn) btn.click();
        });
    }

    // ═══ 7) انتظر input الرقم ═══
    log('\n⏳ انتظار خانة الرقم...', 'cy');
    let phoneInputFound = false;
    for (let i = 0; i < 20; i++) {
        await sleep(1000);
        const result = await findPhoneInput(page);
        if (result.found) {
            phoneInputFound = true;
            log('✅ تم العثور على خانة الرقم', 'g');
            break;
        }
    }

    if (!phoneInputFound) {
        log('⚠️ مش لاقي خانة الرقم — خد screenshot', 'y');
        await page.screenshot({ path: 'wa-debug.png', fullPage: true });
        log('📸 حفظت screenshot في wa-debug.png', 'cy');
    }

    // ═══ 8) اكتب الرقم ═══
    log('\n📝 كتابة الرقم...', 'cy');
    try {
        // ابحث عن input واكتب فيه
        const inputs = await page.$$('input');
        let typed = false;
        for (const input of inputs) {
            try {
                const type = await input.evaluate(el => el.type);
                if (type === 'hidden' || type === 'checkbox' || type === 'radio') continue;
                await input.click();
                await sleep(300);
                // امسح أي حاجة موجودة
                await input.evaluate(el => el.value = '');
                // اكتب الرقم بسرعة بشرية
                for (const char of cleanPhone) {
                    await page.keyboard.type(char, { delay: rand(60, 180) });
                }
                typed = true;
                log('✅ تم كتابة الرقم', 'g');
                break;
            } catch (e) {
                continue;
            }
        }
        
        if (!typed) {
            log('⚠️ مافيش input — هحاول من لوحة المفاتيح', 'y');
            await page.keyboard.type(cleanPhone, { delay: 100 });
        }
    } catch (e) {
        log('❌ ' + e.message, 'r');
    }
    
    await sleep(1000);

    // ═══ 9) اضغط Next ═══
    log('\n🔘 الضغط على Next...', 'cy');
    const nextResult = await findAndClick(page, ['next', 'التالي', 'متابعة', 'continue']);
    if (nextResult.found) {
        log('✅ تم الضغط على Next', 'g');
    } else {
        log('⚠️ مش لاقي Next — هحاول Enter', 'y');
        await page.keyboard.press('Enter');
    }
    
    // ═══ 10) انتظر الكود ═══
    log('\n⏳ انتظار الكود (30 ثانية)...', 'cy');
    let code = null;
    let errMsg = null;
    for (let i = 0; i < 30; i++) {
        await sleep(1000);
        code = await readCode(page);
        if (code) break;
        errMsg = await readPageError(page);
        if (errMsg && (errMsg.includes('تجاوز') || errMsg.includes('exceeded') || errMsg.includes('too many'))) {
            break;
        }
    }

    // ═══ 11) اعرض النتيجة ═══
    console.log('');
    log('╔═══════════════════════════════════════════╗', 'cy');
    if (code) {
        log('║  🔑 الكود: ' + code.padEnd(30) + '║', 'g');
        log('╚═══════════════════════════════════════════╝', 'cy');
        log('\n✅ الصق الكود في واتساب الموبايل (خلال 60 ثانية)!', 'g');
    } else if (errMsg) {
        log('║  ❌ رسالة من واتساب:                     ║', 'r');
        log('║  ' + errMsg.substring(0, 40).padEnd(42) + '║', 'r');
        log('╚═══════════════════════════════════════════╝', 'cy');
        log('\n⚠️ الرقم ده موقوف مؤقتاً', 'y');
        log('⏱️  انتظر 24-72 ساعة وحاول تاني', 'y');
    } else {
        log('║  ⚠️ الكود لم يظهر — افتح المتصفح وشوف  ║', 'y');
        log('╚═══════════════════════════════════════════╝', 'cy');
        await page.screenshot({ path: 'wa-result.png', fullPage: true });
        log('📸 محفوظ في wa-result.png', 'cy');
    }

    console.log('');
    log('💡 المتصفح هيفضل مفتوح 3 دقايق', 'b');
    log('💡 اضغط Ctrl+C للإغلاق', 'b');
    
    // سيب المتصفح مفتوح
    await sleep(180000);
    await browser.close();
    log('\n👋 تم الإغلاق', 'g');
}

// ═══ تشغيل ═══
main().catch(err => {
    log('\n❌ خطأ: ' + err.message, 'r');
    console.error(err);
    process.exit(1);
});
