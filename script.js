// Import tiktoken (Standard GPT-4 tokenizer)
import { encodingForModel } from "https://cdn.jsdelivr.net/npm/js-tiktoken@1.0.10/+esm";

// --- DOM ELEMENTS ---
const els = {
    input: document.getElementById('inputPrompt'),
    output: document.getElementById('outputPrompt'),
    optimizeBtn: document.getElementById('optimizeBtn'),
    copyBtn: document.getElementById('copyBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    sourceLang: document.getElementById('sourceLang'),
    aggressiveMode: document.getElementById('aggressiveMode'),
    inputTokens: document.getElementById('inputTokens'),
    outputTokens: document.getElementById('outputTokens'),
    savingsBadge: document.getElementById('savingsBadge'),
    status: document.getElementById('tokenizerStatus'),
    notification: document.getElementById('recommendation')
};

// --- STATE ---
let enc = null;
let isTranslating = false;

// --- INITIALIZATION ---
(async () => {
    try {
        enc = encodingForModel("gpt-4");
        els.status.textContent = "Logic Ready (Tiktoken Loaded)";
        els.status.classList.add('ready');
        updateInputStats(); // Initial count
    } catch (e) {
        console.error(e);
        els.status.textContent = "Offline Mode (Estimates Only)";
    }
})();

// --- CONFIG ---
// Ultra-minimal suffixes (The shorter, the better)
const SUFFIXES = {
    'es': '\n(用西语答)', // "Reply in Spanish" (4 chars)
    'en': '\n(用英语答)', // "Reply in English"
    'fr': '\n(用法语答)',
    'de': '\n(用德语答)',
    'pt': '\n(用葡语答)',
    'auto': '\n(用原语答)'
};

// Fillers to remove in "Aggressive Mode"
const STOPWORDS = [
    // Polite & Conversational
    /\bplease\b/gi, /\bcould you\b/gi, /\bkindly\b/gi, /\bI would like to\b/gi,
    /\bpor favor\b/gi, /\bpodrías\b/gi, /\bme gustaría\b/gi, /\bquisiera\b/gi,
    /\bs'il vous plait\b/gi, /\bsvp\b/gi,
    
    // Articles (The, A, An, El, La...)
    /\bthe\b/gi, /\ba\b/gi, /\ban\b/gi,
    /\bel\b/gi, /\bla\b/gi, /\blos\b/gi, /\blas\b/gi, /\bun\b/gi, /\buna\b/gi, /\bunos\b/gi, /\bunas\b/gi,
    
    // Prepositions/Connectors (Risky but high yield)
    /\bde\b/gi, /\bdel\b/gi, /\bof\b/gi, // "de" is #1 filler
    /\bthat\b/gi, /\bque\b/gi, /\bwhich\b/gi, /\bcuyos\b/gi,
    /\bwith\b/gi, /\bcon\b/gi,
    /\bin\b/gi, /\ben\b/gi,
    /\bfor\b/gi, /\bpara\b/gi, /\bpor\b/gi,
    /\band\b/gi, /\by\b/gi, /\be\b/gi, // "y" is valid, but "," is better
    
    // 'Be' verbs (Context usually implies them)
    /\bis\b/gi, /\bare\b/gi, /\bam\b/gi, /\bwas\b/gi, /\bwere\b/gi,
    /\bes\b/gi, /\bson\b/gi, /\bestá\b/gi, /\bestán\b/gi, /\bfue\b/gi, /\beran\b/gi,
    
    // Pronouns (In Spanish, verbs imply subject. In Eng, context often enough)
    /\bI\b/g, /\bwe\b/gi, /\byou\b/gi,
    /\byo\b/gi, /\bnosotros\b/gi, /\bellos\b/gi
];

// --- CORE LOGIC ---

function count(text) {
    if (!text) return 0;
    if (enc) return enc.encode(text).length;
    return Math.ceil(text.length / 3); // Better avg for latin. Chinese is ~0.6 chars/token
}

function updateInputStats() {
    const toks = count(els.input.value);
    els.inputTokens.innerText = `${toks} Tokens`;
    return toks;
}

// Cleanup: Removes spaces from Chinese text AND normalizes punctuation
function compactChinese(text) {
    return text.replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2') // No space between Hanzi
               .replace(/\s+/g, ' ') // Collapse multiple spaces
               // Convert Full-width Punctuation to ASCII (Saves bytes, sometimes merges better)
               .replace(/，/g, ',').replace(/。/g, '.')
               .replace(/：/g, ':').replace(/；/g, ';')
               .replace(/？/g, '?').replace(/！/g, '!')
               .replace(/（/g, '(').replace(/）/g, ')')
               .replace(/“/g, '"').replace(/”/g, '"');
}

async function translateChunked(text, source, target) {
    // Smart Splitting: Split by sentence delimiters
    const rawChunks = text.match(/[^.!?\n]+[.!?\n]+(?:\s|$)|[^.!?\n]+$/g) || [text];
    
    let chunks = [];
    let current = "";
    
    for (let section of rawChunks) {
        if (current.length + section.length > 450) {
            chunks.push(current);
            current = section;
        } else {
            current += section;
        }
    }
    if (current) chunks.push(current);

    let results = [];
    const delay = ms => new Promise(r => setTimeout(r, ms));
    
    // Execute translations
    for (let c of chunks) {
        if (!c.trim()) { results.push(c); continue; }
        let translated = false;
        
        // 1. MyMemory (Priority)
        try {
            let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(c.trim())}&langpair=${source}|${target}&de=freak@tokenminimizer.com`;
            let res = await fetch(url);
            
            // Retry once on rate limit
            if (res.status === 429) {
                console.warn("Rate limit hit, pausing...");
                await delay(2000);
                res = await fetch(url);
            }

            let data = await res.json();
            // 200=OK, 403=Limit/Invalid (but sometimes contains text)
            if (data.responseStatus === 200 || (data.responseStatus === 403 && data.responseData.translatedText)) {
                results.push(data.responseData.translatedText);
                translated = true;
            }
        } catch (e) {
            console.warn("MyMemory error:", e);
        }

        // 2. Lingva via Proxy (Fallback)
        if (!translated) {
            console.warn("Trying Lingva fallback...");
            try {
                // Use AllOrigins proxy to bypass CORS on localhost
                const targetApi = `https://lingva.ml/api/v1/${source}/${target}/${encodeURIComponent(c.trim())}`;
                const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetApi)}`;
                const res2 = await fetch(proxyUrl);
                const data2 = await res2.json();
                
                if (data2.translation) {
                    results.push(data2.translation);
                    translated = true;
                }
            } catch(e2) {
                console.error("Backup failed:", e2);
            }
        }

        if (!translated) results.push(c); // Keep original if all fails
        
        await delay(500); // Politeness throttle
    }

    return results.join(" ");
}

// --- EVENT HANDLERS ---

els.input.addEventListener('input', updateInputStats);

// Debugging: Check if elements exist
if (!els.optimizeBtn) console.error("Button not found!");

els.optimizeBtn.addEventListener('click', async () => {
    console.log("Button clicked!"); // Debug log
    if (isTranslating) return;
    const rawInput = els.input.value.trim();
    if (!rawInput) {
        // Visual feedback instead of just alert
        els.input.style.borderColor = 'var(--danger)';
        els.input.setAttribute('placeholder', '⚠️ Please enter a prompt first!');
        setTimeout(() => {
            els.input.style.borderColor = '';
            els.input.setAttribute('placeholder', 'Paste your long prompt here...');
        }, 2000);
        return;
    }

    isTranslating = true;
    els.optimizeBtn.innerHTML = "Processing...";
    els.optimizeBtn.style.opacity = "0.7";

    // DECISION STRATEGY
    const useNuclear = els.aggressiveMode && els.aggressiveMode.checked;
    const isShort = rawInput.length < 150; // Threshold for overhead viability
    
    // Strategy: 
    // 1. Long + Nuclear -> Translate to Chinese (Max Compression)
    // 2. Short + Nuclear -> "Caveman Mode" (Strip words, Keep lang, NO suffix) -> Beats translation overhead
    // 3. Normal Mode -> Translate to English (Standard optimization)
    
    let targetLang;
    if (useNuclear) {
        targetLang = isShort ? 'caveman' : 'zh-CN';
    } else {
        targetLang = 'en';
    }

    // 1. Pre-processing (Aggressive / Caveman)
    let textToTranslate = rawInput;
    if (useNuclear) { // Apply to both Chinese and Caveman strategies
        STOPWORDS.forEach(regex => {
            textToTranslate = textToTranslate.replace(regex, '');
        });
        textToTranslate = textToTranslate.replace(/\s+/g, ' ').trim();
    }

    const sourceLang = els.sourceLang ? (els.sourceLang.value === 'auto' ? 'es' : els.sourceLang.value) : 'es';

    try {
        console.log(`Optimization Strategy: ${targetLang} (Source: ${sourceLang})`);
        
        let finalOutput = "";

        if (targetLang === 'caveman') {
            // DIRECT BYPASS: No translation API call needed
            // Just the stripped text. The AI will reply in source lang implicitly because input is in source lang.
            finalOutput = textToTranslate; 
            
            // Visual feedback that we skipped translation for efficiency
            els.notification.innerHTML = "⚡ <strong>Smart Bypass:</strong> Short prompt detected. 'Caveman Mode' used to avoid translation overhead.";
            els.notification.classList.remove('hidden');
            setTimeout(() => els.notification.classList.add('hidden'), 5000);

        } else {
            // Full Translation Pipeline
            let translated = await translateChunked(textToTranslate, sourceLang, targetLang);
            
            // Post-Process
            let optimized;
            if (targetLang === 'zh-CN') {
                optimized = compactChinese(translated);
            } else {
                optimized = translated;
            }
            
            // Add Instruction Suffix (Only needed if we changed language)
            const suffix = SUFFIXES[sourceLang] || SUFFIXES['auto'];
            finalOutput = optimized + suffix;
        }

        // 5. Compare & Decide
        const inputT = count(rawInput);
        const outputT = count(finalOutput);
        
        els.output.value = finalOutput;
        els.outputTokens.innerText = `${outputT} Tokens`;

        const savings = inputT - outputT;
        const percent = inputT > 0 ? Math.round((savings / inputT) * 100) : 0;

        els.savingsBadge.classList.remove('hidden', 'positive', 'negative');
        els.savingsBadge.style.display = 'inline-block'; // Force show
        
        if (savings > 0) {
            els.savingsBadge.textContent = `SAVED: ${percent}% (${savings} Tok)`;
            els.savingsBadge.classList.add('positive');
        } else {
            els.savingsBadge.textContent = `INCREASE: ${Math.abs(percent)}%`;
            els.savingsBadge.classList.add('negative');
        }

    } catch (err) {
        console.error(err);
        els.output.value = "Error: " + err.message;
    } finally {
        isTranslating = false;
        els.optimizeBtn.innerHTML = `MINIMIZE TOKENS <span class="btn-icon">➔</span>`;
        els.optimizeBtn.style.opacity = "1";
    }
});

// Utilities
els.copyBtn.addEventListener('click', () => {
    els.output.select();
    document.execCommand('copy');
    els.copyBtn.textContent = "Copied!";
    setTimeout(() => els.copyBtn.textContent = "Copy", 1500);
});

els.downloadBtn.addEventListener('click', () => {
    const blob = new Blob([els.output.value], {type:'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'optimized.toon';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
});

// Keyboard shortcut: Ctrl+Enter to optimize
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        els.optimizeBtn.click();
    }
});
