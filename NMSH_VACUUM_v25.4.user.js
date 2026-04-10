// ==UserScript==
// @name         N*M*S*H*N VACUUM
// @namespace    http://tampermonkey.net/
// @version      25.4
// @description  VACUUM — Maximum performance HIT catcher. Worker ID licensed.
// @author       MRPsoft
// @match        https://worker.mturk.com/*
// @match        https://www.mturk.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        unsafeWindow
// @connect      worker.mturk.com
// @connect      www.mturk.com
// @connect      docs.google.com
// @connect      script.google.com
// @connect      www.allbyjohn.com
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    var TOOL_NAME   = 'N*M*S*H*N';
    var VERSION     = '25.4';
    var STORAGE_KEY = 'mrp_v14';
    var WAS_RUNNING = 'mrp_was_running';
    var CAP_RESUME  = 'mrp_cap_resume';   // separate from WAS_RUNNING so startScan can't clobber it
    var LIC_KEY     = 'mrp_lic_v14';

    // Google Sheet — Column B = authorized Worker IDs. Must be shared publicly (Anyone with link → Viewer)
    var SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1jFW7kRAJNGRGqhZXa8ghyNqP35-nwrJisW4qOLfqJoE/export?format=csv&gid=0';

    // MEGA Sheet — Worker IDs managed by admin. MEGA button reads this sheet.
    var MEGA_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1PuJ2lBLOAzv9jwA-6cS0hehBomlDX-kLiywivqxw5u0/export?format=csv&gid=0';

    // MEGA global kill key — shared across ALL tabs via GM_setValue
    // When any account sets this to '1', every other running tab stops immediately
    var MEGA_GLOBAL_KEY = 'mrp_mega_global';

    // ── CROSS-BROWSER SYNC ──
    // Google Apps Script Web App URL for cross-browser START/STOP/MEGA sync.
    // All browsers (different computers/phones) poll this URL every 3 seconds.
    // Deploy the included NMSH_SYNC_AppScript.gs, paste your Web App URL here.
    var SYNC_API_URL = 'https://script.google.com/macros/s/AKfycbyVyoW1UNGzIrW2fQApkS09bZPqfIeysgPBSony8glp8bHa_geJvS7U7UFikwAfWIxT/exec';

    // Team detection — populated on startup by reading MEGA sheet
    // teamKey   = sanitized team name used as signal key (e.g. "NOUSHAD_TEAM")
    // teamLabel = display label shown in panel (e.g. "N Team")
    var _teamKey   = 'DEFAULT';
    var _teamLabel = '?';

    if (!/worker\.mturk\.com|www\.mturk\.com/i.test(location.hostname)) return;

    // ================================================================
    //  HELPERS
    // ================================================================
    function pad2(n){ return n < 10 ? '0' + n : String(n); }
    function now(){ return Date.now(); }
    function monthKey(){
        var d = new Date();
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
    }
    function daysLeft(){
        var d = new Date();
        return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate();
    }
    function expiryStr(){
        var d = new Date(), last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
        var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return m[last.getMonth()] + ' ' + last.getDate() + ', ' + last.getFullYear();
    }
    function monthName(){
        return ['January','February','March','April','May','June',
                'July','August','September','October','November','December'][new Date().getMonth()];
    }

    // ================================================================
    //  CSV PARSER — RFC 4180 compliant: handles quoted fields, escaped
    //  quotes ("" → "), and quoted commas. Skips empty lines.
    // ================================================================
    function parseCSV(txt){
        // Strip UTF-8 BOM that Google Sheets sometimes prepends
        txt = (txt || '').replace(/^\uFEFF/, '');
        var rows = [];
        txt.split('\n').forEach(function(line){
            // v25.4: only trim CR — preserve significant whitespace inside fields,
            // but strip trailing \r from CRLF endings.
            line = line.replace(/\r$/, '');
            if (!line) return;
            var cols = [], inQ = false, cur = '';
            for (var i = 0; i < line.length; i++){
                var c = line[i];
                if (c === '"'){
                    // RFC 4180: a doubled quote inside a quoted field is an escaped quote
                    if (inQ && line[i + 1] === '"'){ cur += '"'; i++; }
                    else inQ = !inQ;
                } else if (c === ',' && !inQ){
                    cols.push(cur.trim()); cur = '';
                } else cur += c;
            }
            cols.push(cur.trim());
            rows.push(cols);
        });
        return rows;
    }

    // ================================================================
    //  TEAM DETECTION — reads MEGA sheet, finds which column owns
    //  this worker ID, returns { key, label } for the team.
    //
    //  Sheet layout:
    //    Row 1:  Team names  →  "NOUSHAD TEAM" | "M TEAM" | ...
    //    Row 2+: Worker IDs  →  A1SU...        | ASP7...  | ...
    //
    //  label = first character(s) of team name + " Team"
    //  key   = sanitized uppercase version used as API signal key
    // ================================================================
    function detectTeam(workerId, cb) {
        if (!workerId || !MEGA_SHEET_URL) { cb('DEFAULT', '? Team'); return; }
        GM_xmlhttpRequest({
            method: 'GET',
            url: MEGA_SHEET_URL + '&nocache=' + now(),
            headers: { 'Cache-Control': 'no-cache', 'Accept': 'text/csv,text/plain,*/*' },
            timeout: 15000,
            onload: function(r) {
                if (r.status !== 200 || (r.responseText || '').indexOf('<html') > -1) {
                    cb('DEFAULT', '? Team'); return;
                }
                var rows = parseCSV(r.responseText);
                if (!rows || rows.length < 2) { cb('DEFAULT', '? Team'); return; }

                var headers = rows[0];   // Row 1 = team names
                var wid = workerId.toUpperCase().trim();

                // Search every column for this worker ID
                for (var col = 0; col < headers.length; col++) {
                    for (var row = 1; row < rows.length; row++) {
                        var cell = (rows[row][col] || '').toUpperCase().trim().replace(/\r/g,'');
                        if (cell === wid) {
                            // Found — get team name from header
                            var rawName = (headers[col] || '').trim() || ('Team ' + (col + 1));
                            // key: uppercase, spaces→underscore, only alphanum+underscore
                            var key = rawName.toUpperCase().replace(/\s+/g,'_').replace(/[^A-Z0-9_]/g,'').substring(0, 40) || 'DEFAULT';
                            // label: first word's first letter + " Team"
                            var firstWord = rawName.split(/\s+/)[0] || rawName;
                            var label = firstWord.charAt(0).toUpperCase() + ' Team';
                            cb(key, label, rawName);
                            return;
                        }
                    }
                }
                // Not found in sheet — use DEFAULT
                cb('DEFAULT', '? Team');
            },
            onerror:   function() { cb('DEFAULT', '? Team'); },
            ontimeout: function() { cb('DEFAULT', '? Team'); }
        });
    }
    // ================================================================
    function detectWorkerId(cb){
        // Pattern: MTurk Worker IDs always start with A, 10-20 chars alphanumeric
        var WID_RE = /\b(A[A-Z0-9]{9,19})\b/;

        // ── Method 1: Scan ALL text nodes visible on page right now ──
        // The worker ID "A1SUMUAP2HD6I1" is printed on the page by MTurk/extensions.
        // Walk every text node and grab the first match.
        function scanTextNodes(){
            var walker = document.createTreeWalker(document.body, 4, null, false); // NodeFilter.SHOW_TEXT = 4
            var node;
            while ((node = walker.nextNode())){
                var t = (node.nodeValue || '').trim();
                if (t.length > 5 && t.length < 100){
                    var m = t.match(WID_RE);
                    if (m) return m[1];
                }
            }
            return null;
        }
        var fromDOM = scanTextNodes();
        if (fromDOM){ cb(fromDOM); return; }

        // ── Method 2: window globals MTurk sets ──
        try {
            var win = unsafeWindow || window;
            var globals = ['__reactInitialState__','__INITIAL_STATE__','__APP_STATE__',
                           'turkerId','workerId','worker_id','WORKER_ID','currentWorker'];
            for (var g = 0; g < globals.length; g++){
                var val = win[globals[g]];
                if (!val) continue;
                var str = typeof val === 'string' ? val : JSON.stringify(val);
                var wm = str.match(WID_RE);
                if (wm){ cb(wm[1]); return; }
            }
        } catch(e){}

        // ── Method 3: All <script> tags on page (MTurk embeds JSON state) ──
        var scripts = document.querySelectorAll('script');
        for (var s = 0; s < scripts.length; s++){
            var sc = scripts[s].textContent || '';
            if (sc.length > 50 && sc.indexOf('A') > -1){
                var sm = sc.match(/worker[_\-]?id['":\s]+([A-Z0-9]{10,20})/i) ||
                         sc.match(/"id"\s*:\s*"(A[A-Z0-9]{9,19})"/i) ||
                         sc.match(/\b(A[A-Z0-9]{13,19})\b/);
                if (sm && sm[1] && /^A[A-Z0-9]{9,19}$/.test(sm[1])){ cb(sm[1]); return; }
            }
        }

        // ── Method 4: Cookie ──
        var ck = (document.cookie || '').match(/worker_id=([A-Z0-9]{10,20})/i);
        if (ck && ck[1]){ cb(ck[1].toUpperCase()); return; }

        // ── Method 5: Fetch MTurk worker profile API ──
        var tried = 0;
        var apis = [
            'https://worker.mturk.com/api/worker',
            'https://worker.mturk.com/api/profile',
            'https://worker.mturk.com/worker_requirements'
        ];
        function tryApi(){
            if (tried >= apis.length){ tryDashboard(); return; }
            var url = apis[tried++];
            GM_xmlhttpRequest({
                method: 'GET',
                url: url + '?_=' + now(),
                headers: { 'Accept': 'application/json, text/html', 'X-Requested-With': 'XMLHttpRequest' },
                timeout: 8000,
                onload: function(r){
                    var found = extractWid(r.responseText || '');
                    if (found){ cb(found); return; }
                    tryApi();
                },
                onerror:   function(){ tryApi(); },
                ontimeout: function(){ tryApi(); }
            });
        }

        // ── Method 6: Fetch full dashboard HTML ──
        function tryDashboard(){
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://worker.mturk.com/dashboard?_=' + now(),
                headers: { 'Accept': 'text/html' },
                timeout: 12000,
                onload: function(r){
                    var found = extractWid(r.responseText || '');
                    cb(found || null);
                },
                onerror:   function(){ cb(null); },
                ontimeout: function(){ cb(null); }
            });
        }

        tryApi();

        function extractWid(text){
            var pats = [
                /worker[_\-]?id['":\s]+([A-Z0-9]{10,20})/i,
                /"id"\s*:\s*"(A[A-Z0-9]{12,19})"/i,
                /\b(A[A-Z0-9]{13,19})\b/
            ];
            for (var i = 0; i < pats.length; i++){
                var m = text.match(pats[i]);
                if (m && m[1] && /^A[A-Z0-9]{9,19}$/.test(m[1])) return m[1].toUpperCase();
            }
            return null;
        }
    }

    // ================================================================
    //  LICENSE — Worker ID checked against Google Sheet (Column A)
    //  IDs are in Column A. Scans ALL cells in ALL rows.
    //  Tries multiple export URL formats in case one fails.
    //  Shows detailed debug info if authorization fails.
    // ================================================================
    var LIC = {
        isLocalValid: function(){
            try {
                var s = JSON.parse(GM_getValue(LIC_KEY, '{}'));
                return !!(s && s.mk && s.mk === monthKey() && s.workerId);
            } catch(e){ return false; }
        },
        savedWorkerId: function(){
            try { return JSON.parse(GM_getValue(LIC_KEY, '{}')).workerId || ''; } catch(e){ return ''; }
        },
        save: function(wid){
            try {
                GM_setValue(LIC_KEY, JSON.stringify({
                    workerId: wid.toUpperCase().trim(),
                    mk: monthKey(),
                    at: now()
                }));
            } catch(e){}
        },
        clear: function(){ try { GM_setValue(LIC_KEY, '{}'); } catch(e){} },

        // Parse CSV and extract every cell that looks like a Worker ID
        _extractIds: function(csvText){
            csvText = (csvText || '').replace(/^\uFEFF/, '');
            var ids = {};
            var workerRx = /^A[A-Z0-9]{5,19}$/;
            csvText.split('\n').forEach(function(line){
                line = line.trim(); if (!line) return;
                // Split by comma, strip quotes
                var parts = line.split(',');
                parts.forEach(function(part){
                    var v = part.replace(/^["'\s]+|["'\s]+$/g, '').toUpperCase().replace(/\s+/g,'');
                    // Remove any \r leftover
                    v = v.replace(/\r/g,'');
                    if (v && workerRx.test(v)) ids[v] = true;
                });
            });
            return ids;
        },

        // Try to fetch and check — calls setSt to show live debug status
        check: function(wid, cb, setSt){
            wid = (wid || '').toUpperCase().trim().replace(/\s+/g, '').replace(/\r/g,'');
            if (!wid){ cb(false, 'Worker ID is empty'); return; }
            if (wid.length < 6){ cb(false, 'Worker ID too short (min 6 chars)'); return; }

            var self = this;
            if (setSt) setSt('Fetching authorized list from Google...', null);

            // Try export URL — always fresh with cache buster
            var url = SHEET_CSV_URL + '&nocache=' + now();

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: {
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Accept': 'text/csv,text/plain,*/*'
                },
                timeout: 30000,
                onload: function(r){
                    var body = r.responseText || '';
                    var status = r.status;
                    var finalUrl = r.finalUrl || '';

                    // Detect if Google returned a login/error HTML page instead of CSV
                    if (status !== 200 || body.indexOf('<!DOCTYPE') > -1 || body.indexOf('<html') > -1){
                        // Sheet not publicly accessible
                        var hint = '';
                        if (status === 401 || status === 403) hint = ' (sheet not public)';
                        else if (status === 302 || finalUrl.indexOf('accounts.google') > -1) hint = ' (sheet requires login — make it public)';
                        else if (body.length < 100) hint = ' (sheet returned empty — check sharing)';
                        cb(false, 'Cannot read sheet (HTTP ' + status + ')' + hint + '. Share sheet: Anyone → Viewer');
                        return;
                    }

                    // Got a CSV response — parse it
                    var ids = self._extractIds(body);
                    var totalFound = Object.keys(ids).length;

                    if (totalFound === 0){
                        // Got CSV but no Worker IDs found — show what we got
                        var preview = body.substring(0, 80).replace(/\n/g,'|');
                        cb(false, 'Sheet loaded but no Worker IDs found in it. Preview: "' + preview + '"');
                        return;
                    }

                    // Check if this specific ID is in the list
                    if (ids[wid]){
                        cb(true, 'OK — found in ' + totalFound + ' authorized IDs');
                    } else {
                        cb(false, 'ID not in list (' + totalFound + ' IDs checked). Verify your Worker ID matches exactly.');
                    }
                },
                onerror: function(e){
                    cb(false, 'Network error — cannot reach Google Sheets. Check internet & try again.');
                },
                ontimeout: function(){
                    cb(false, 'Timeout after 30s — sheet may be private or Google is slow. Try again.');
                }
            });
        },

        bgVerify: function(){
            var saved = this.savedWorkerId();
            if (!saved) return;
            var self = this;
            this.check(saved, function(ok){ if (!ok && !mainStarted) self.clear(); }, null);
        }
    };

    // ================================================================
    //  AUTH SCREEN
    //  Shows a small corner badge during detection — MTurk page loads
    //  normally underneath so worker ID is detectable from the DOM.
    //  Only shows full-screen block if ID is not authorized.
    // ================================================================
    var mainStarted = false;
    var licTimer = null;

    function showLicScreen(onOK){
        function build(){
            if (!document.body){ setTimeout(build, 50); return; }
            injectLicCSS();
            var ex = document.getElementById('nmsh-lic'); if (ex) ex.remove();

            // Small corner badge — does NOT cover the page
            var ov = document.createElement('div');
            ov.id = 'nmsh-lic';
            ov.innerHTML =
                '<div class="nl-badge">' +
                    '<div class="nl-badge-logo">' + TOOL_NAME + '</div>' +
                    '<div class="nl-badge-ver">v' + VERSION + '</div>' +
                    '<div class="nl-badge-wid" id="nl-wid-show">Detecting...</div>' +
                    '<div class="nl-badge-st" id="nl-st">Checking...</div>' +
                '</div>';
            document.body.appendChild(ov);

            var st  = document.getElementById('nl-st');
            var wds = document.getElementById('nl-wid-show');

            function setSt(msg, ok){
                if (!st) return;
                st.textContent = msg;
                st.style.color = ok === true ? '#2ecc71' : ok === false ? '#e74c3c' : '#f39c12';
            }

            function showBlockScreen(msg){
                // NOW show full-screen block — page is already loaded, just lock it
                ov.remove();
                var bl = document.createElement('div');
                bl.id = 'nmsh-lic';
                bl.innerHTML =
                    '<div class="nl-overlay">' +
                        '<div class="nl-box">' +
                            '<div class="nl-logo">' + TOOL_NAME + '</div>' +
                            '<div class="nl-sub">VACUUM · v' + VERSION + '</div>' +
                            '<div class="nl-month">' + monthName() + ' ' + new Date().getFullYear() + '</div>' +
                            '<div class="nl-clock" id="nl-clk">--:--:--</div>' +
                            '<div class="nl-date" id="nl-dt"></div>' +
                            '<div class="nl-sep"></div>' +
                            '<div class="nl-wid-display" style="color:#e74c3c">Not Authorized</div>' +
                            '<div class="nl-status nl-err">' + msg + '</div>' +
                            '<div class="nl-footer">Contact your administrator to get access</div>' +
                        '</div>' +
                    '</div>';
                document.body.appendChild(bl);
                function tick(){
                    var d = new Date();
                    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
                    var ms2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                    var ce = document.getElementById('nl-clk'), de = document.getElementById('nl-dt');
                    if (ce) ce.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
                    if (de) de.textContent = days[d.getDay()] + ', ' + ms2[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
                }
                tick();
                if (licTimer) clearInterval(licTimer);
                licTimer = setInterval(tick, 1000);
            }

            // Retry detection — tries API endpoints first, then DOM
            var detectAttempts = 0;
            var maxAttempts    = 10;

            function tryDetect(){
                detectAttempts++;
                if (wds) wds.textContent = 'Detecting... ' + detectAttempts + '/' + maxAttempts;
                setSt('Checking MTurk API...', null);

                detectWorkerId(function(autoId){
                    if (autoId){
                        autoId = autoId.toUpperCase().trim();
                        var masked = autoId.substring(0,4) + '***' + autoId.substring(autoId.length - 3);
                        if (wds) wds.textContent = masked;
                        setSt('Verifying sheet...', null);

                        checkMegaSheet(autoId, function(ok, teamInfo){
                            if (ok){
                                LIC.save(autoId);
                                setSt('✓ ' + (teamInfo || 'Authorized'), true);
                                setTimeout(function(){ ov.remove(); onOK(); }, 800);
                            } else {
                                showBlockScreen('✗ Worker ID ' + masked + ' is not in the authorized list.');
                            }
                        });

                    } else if (detectAttempts < maxAttempts){
                        setSt('Retrying in 3s...', null);
                        setTimeout(tryDetect, 3000);
                    } else {
                        showBlockScreen('✗ Could not detect Worker ID after ' + maxAttempts + ' attempts. Make sure you are logged in to MTurk and reload the page.');
                    }
                });
            }

            setTimeout(tryDetect, 1000);
        }
        build();
    }

    // ================================================================
    //  MEGA SHEET AUTH CHECK
    //  Reads MEGA sheet, searches ALL columns for this worker ID.
    //  Returns (true, "N Team") if found, (false, null) if not.
    // ================================================================
    function checkMegaSheet(wid, cb){
        wid = (wid || '').toUpperCase().trim();
        GM_xmlhttpRequest({
            method: 'GET',
            url: MEGA_SHEET_URL + '&nocache=' + now(),
            headers: { 'Cache-Control': 'no-cache', 'Accept': 'text/csv,text/plain,*/*' },
            timeout: 20000,
            onload: function(r){
                if (r.status !== 200 || (r.responseText || '').indexOf('<html') > -1){
                    // Sheet unreachable (bad status or Google login page) = network problem
                    cb(false, null, 'network_error'); return;
                }
                var rows = parseCSV(r.responseText);
                if (!rows || rows.length < 2){ cb(false, null, 'network_error'); return; }

                var headers = rows[0];
                for (var col = 0; col < headers.length; col++){
                    for (var row = 1; row < rows.length; row++){
                        var cell = (rows[row][col] || '').toUpperCase().trim().replace(/\r/g,'');
                        if (cell === wid){
                            var rawName  = (headers[col] || '').trim() || ('Team ' + (col+1));
                            var firstChr = rawName.charAt(0).toUpperCase();
                            cb(true, firstChr + ' Team (' + rawName + ')');
                            return;
                        }
                    }
                }
                // Sheet loaded fine but ID genuinely not in it
                cb(false, null, 'not_found');
            },
            onerror:   function(){ cb(false, null, 'network_error'); },
            ontimeout: function(){ cb(false, null, 'network_error'); }
        });
    }

    function injectLicCSS(){
        var css =
        // ── Corner badge (during detection — page fully visible underneath) ──
        '#nmsh-lic .nl-badge{position:fixed;bottom:16px;right:16px;z-index:2147483647;background:rgba(10,10,10,.93);border:1px solid #2a2a2a;border-radius:10px;padding:10px 14px;font-family:system-ui,sans-serif;backdrop-filter:blur(6px);box-shadow:0 4px 20px rgba(0,0,0,.7);min-width:170px;text-align:center}' +
        '.nl-badge-logo{font:900 13px system-ui;color:#e74c3c;letter-spacing:3px}' +
        '.nl-badge-ver{font:600 8px system-ui;color:#333;letter-spacing:2px;margin-bottom:6px}' +
        '.nl-badge-wid{font:800 11px Consolas,monospace;color:#f39c12;letter-spacing:2px;margin-bottom:4px;min-height:14px}' +
        '.nl-badge-st{font:600 9px system-ui;color:#f39c12;min-height:12px}' +
        // ── Full-screen block (only when NOT authorized) ──
        '#nmsh-lic .nl-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:linear-gradient(135deg,#080808,#111);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}' +
        '.nl-box{background:#0f0f0f;border:1px solid #1e1e1e;border-radius:14px;padding:36px 44px;text-align:center;width:400px;box-shadow:0 30px 80px rgba(0,0,0,.9)}' +
        '.nl-logo{font:900 30px system-ui;color:#e74c3c;letter-spacing:4px;text-shadow:0 0 30px rgba(231,76,60,.5)}' +
        '.nl-sub{font:700 9px system-ui;color:#333;letter-spacing:3px;margin-top:4px;margin-bottom:4px;text-transform:uppercase}' +
        '.nl-month{font:900 14px system-ui;color:#fff;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px}' +
        '.nl-clock{font:900 48px/1 Consolas,monospace;color:#2ecc71;letter-spacing:4px;text-shadow:0 0 20px rgba(46,204,113,.4);margin-bottom:5px}' +
        '.nl-date{font:600 11px system-ui;color:#444;margin-bottom:20px}' +
        '.nl-sep{height:1px;background:linear-gradient(90deg,transparent,#222,transparent);margin-bottom:20px}' +
        '.nl-wid-display{font:900 16px/1 Consolas,monospace;letter-spacing:3px;margin-bottom:14px;min-height:20px}' +
        '.nl-status{font:700 10px system-ui;margin-top:12px;min-height:16px;line-height:1.5}' +
        '.nl-ok{color:#2ecc71}.nl-err{color:#e74c3c}.nl-wait{color:#f39c12}' +
        '.nl-footer{font:600 8px system-ui;color:#2a2a2a;margin-top:18px;letter-spacing:.5px}';
        try { GM_addStyle(css); } catch(e){ var s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); }
    }

    // ================================================================
    //  STARTUP GATE
    //  Auth source: MEGA sheet only. No manual input possible.
    //  Flow:
    //    1. Detect real MTurk worker ID from page
    //    2. Check against MEGA sheet
    //    3. Found → save + run. Not found → hard block.
    //    4. Background re-verify every 5 min — removed from sheet = stop immediately
    // ================================================================
    function gate(){
        var savedId = LIC.savedWorkerId();
        if (savedId && LIC.isLocalValid()){
            // Show a quick loading badge so screen isn't blank during sheet check
            function showCheckingBadge(){
                if (!document.body){ setTimeout(showCheckingBadge, 50); return; }
                injectLicCSS();
                var ex = document.getElementById('nmsh-lic'); if (ex) return; // already showing
                var ov = document.createElement('div'); ov.id = 'nmsh-lic';
                ov.innerHTML = '<div class="nl-badge"><div class="nl-badge-logo">' + TOOL_NAME + '</div><div class="nl-badge-ver">v' + VERSION + '</div><div class="nl-badge-wid">' + savedId.substring(0,4) + '***' + savedId.substring(savedId.length-3) + '</div><div class="nl-badge-st" id="nl-st-g" style="color:#f39c12">Verifying...</div></div>';
                document.body.appendChild(ov);
            }
            showCheckingBadge();
            // Quick re-verify against MEGA sheet
            checkMegaSheet(savedId, function(ok, teamInfo, reason){
                var badge = document.getElementById('nmsh-lic'); if (badge) badge.remove();
                if (ok){
                    initMain();
                    startBgReVerify();
                } else if (reason === 'network_error'){
                    // Internet is down or sheet unreachable — session is locally valid,
                    // so trust it and proceed. BgReVerify will re-check every 5 min.
                    initMain();
                    startBgReVerify();
                } else {
                    // Sheet was reachable but ID was not found — genuine removal
                    LIC.clear();
                    if (document.body) showLicScreen(function(){ initMain(); startBgReVerify(); });
                    else document.addEventListener('DOMContentLoaded', function(){
                        showLicScreen(function(){ initMain(); startBgReVerify(); });
                    });
                }
            });
        } else {
            LIC.clear();
            if (document.body) showLicScreen(function(){ initMain(); startBgReVerify(); });
            else document.addEventListener('DOMContentLoaded', function(){
                showLicScreen(function(){ initMain(); startBgReVerify(); });
            });
        }
    }

    // Background re-verify — runs every 5 min
    // Network error (internet drop) → reload dashboard to re-auth on reconnect
    // ID genuinely not found in sheet → hard block immediately
    var _bgReVerifyFails = 0;
    var _bgReVerifyTimer = null; // v25.2: single interval — prevent stacking
    function startBgReVerify(){
        if (_bgReVerifyTimer) clearInterval(_bgReVerifyTimer);
        _bgReVerifyTimer = setInterval(function(){
            var wid = LIC.savedWorkerId();
            if (!wid) return;
            checkMegaSheet(wid, function(ok, teamInfo, reason){
                if (ok){ _bgReVerifyFails = 0; return; }
                if (reason === 'network_error'){
                    _bgReVerifyFails++;
                    if (_bgReVerifyFails >= 2){
                        _bgReVerifyFails = 0;
                        try { location.href = 'https://worker.mturk.com/dashboard'; } catch(e){}
                    }
                    return;
                }
                // reason === 'not_found' — sheet reachable, ID genuinely removed
                _bgReVerifyFails = 0;
                LIC.clear();
                try { if (typeof stopScan === 'function') stopScan(true); } catch(e){}
                var bl = document.getElementById('nmsh-blocked');
                if (!bl){
                    bl = document.createElement('div');
                    bl.id = 'nmsh-blocked';
                    bl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui';
                    bl.innerHTML = '<div style="text-align:center;color:#e74c3c"><div style="font:900 28px system-ui;letter-spacing:4px;margin-bottom:12px">' + TOOL_NAME + '</div><div style="font:700 14px system-ui;color:#fff;margin-bottom:8px">Authorization Revoked</div><div style="font:600 11px system-ui;color:#666">This Worker ID is no longer authorized.<br>Contact your administrator.</div></div>';
                    document.body.appendChild(bl);
                }
            });
        }, 5 * 60 * 1000); // every 5 minutes
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', gate);
    else gate();

    // ================================================================
    // ================================================================
    //  MAIN SCRIPT
    // ================================================================
    // ================================================================
    var panelBuilt = false;

    function initMain(){
        if (mainStarted) return;
        mainStarted = true;

        // Month-end auto-lock — checked every 60s after all functions are defined
        // FIX: Was referencing stopScan before it was defined (TDZ in strict).
        //      Resolved by using a named ref set at end of initMain.
        setInterval(function(){
            if (!LIC.isLocalValid()){
                LIC.clear();
                var wasRun = runtime && runtime.isRunning;
                if (wasRun && typeof stopScan === 'function') stopScan(true);
                showLicScreen(function(){
                    log('Re-authorized for ' + monthName(), 'success');
                    // Only auto-restart if it was running when lock triggered
                    if (wasRun) setTimeout(function(){ if (typeof startScan === 'function') startScan(); }, 600);
                });
            }
        }, 60000);

        // ================================================================
        //  CAPTCHA SYSTEM
        // ================================================================
        var captchaSystem = {
            probeTimer: null, probeInterval: 600000,
            solveTimer: null, alertTimer: null, resumeTimer: null,
            isCaptchaTab: false, captchaActive: false, lastProbe: 0,

            hasCaptchaInText: function(h){
                return h ? /captchacharacters|validatecaptcha|\/captcha\/|g-recaptcha|recaptcha-checkbox|captchainput|opfcaptcha/i.test(h) : false;
            },
            hasCaptchaOnPage: function(){
                if (!document.body) return false;
                if (document.querySelector('img[src*="captcha" i],iframe[src*="recaptcha"],.g-recaptcha,.recaptcha-checkbox-border,input[name="captchacharacters"],form[action*="captcha" i]')) return true;
                return /captchacharacters|CaptchaInput|validateCaptcha|opfcaptcha/i.test(document.body.innerHTML || '');
            },
            markSeen: function(){ try { GM_setValue('mrp_cap_ts', now()); } catch(e){} },
            clearMark: function(){ try { GM_setValue('mrp_cap_ts', 0); } catch(e){} },

            playAlert: function(){
                try {
                    var ctx = new (window.AudioContext || window.webkitAudioContext)();
                    var comp = ctx.createDynamicsCompressor();
                    comp.threshold.value = -3; comp.ratio.value = 15; comp.connect(ctx.destination);
                    [800,1200,800,1200,600,1000,600,1400].forEach(function(f, i){
                        ['square','sawtooth'].forEach(function(type){
                            var o = ctx.createOscillator(), g = ctx.createGain();
                            o.type = type; o.frequency.value = f; o.connect(g); g.connect(comp);
                            var t = ctx.currentTime + i * .1;
                            g.gain.setValueAtTime(type === 'square' ? .9 : .5, t);
                            g.gain.exponentialRampToValueAtTime(.01, t + .09);
                            o.start(t); o.stop(t + .09);
                        });
                    });
                    setTimeout(function(){ try { ctx.close(); } catch(e){} }, 2000);
                } catch(e){}
            },
            startRepeating: function(){
                var s = this; this.stopRepeating(); this.playAlert();
                this.alertTimer = setInterval(function(){ if (!s.captchaActive){ s.stopRepeating(); return; } s.playAlert(); }, 20000);
            },
            stopRepeating: function(){ if (this.alertTimer){ clearInterval(this.alertTimer); this.alertTimer = null; } },
            showOverlay: function(){
                var s = this;
                var ex = document.getElementById('mrp-cap-ov'); if (ex) ex.remove();
                var ov = document.createElement('div'); ov.id = 'mrp-cap-ov';
                ov.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647';
                // v25.4: build via DOM (no inline onclick — CSP-safe) and the OK
                // button MUST silence the recurring alert tone, not just hide the bar.
                var bar = document.createElement('div');
                bar.style.cssText = 'background:#c0392b;color:#fff;padding:10px;text-align:center;font:bold 16px system-ui;box-shadow:0 3px 15px rgba(0,0,0,.4)';
                bar.appendChild(document.createTextNode('CAPTCHA — SOLVE NOW'));
                var sub = document.createElement('span');
                sub.style.cssText = 'display:block;font-size:11px;opacity:.8;margin-top:3px';
                sub.textContent = this.isCaptchaTab ? 'Tab closes after solve' : 'Scan auto-resumes after solve';
                bar.appendChild(sub);
                var btn = document.createElement('button');
                btn.textContent = 'OK';
                btn.style.cssText = 'margin-left:12px;padding:3px 10px;background:#fff;color:#c0392b;border:none;border-radius:3px;font-weight:bold;cursor:pointer';
                btn.addEventListener('click', function(){
                    s.stopRepeating();   // <-- silence the 20s tone loop
                    ov.remove();
                });
                bar.appendChild(btn);
                ov.appendChild(bar);
                if (document.body) document.body.appendChild(ov);
            },
            removeOverlay: function(){ var el = document.getElementById('mrp-cap-ov'); if (el) el.remove(); },
            startSolveMonitor: function(){
                var s = this;
                if (this.solveTimer) clearInterval(this.solveTimer);
                this.solveTimer = setInterval(function(){ if (!s.hasCaptchaOnPage()) s.onSolved(); }, 500);
            },
            onSolved: function(){
                if (this.solveTimer){ clearInterval(this.solveTimer); this.solveTimer = null; }
                this.stopRepeating(); this.stopResumeWatch();
                if (this.isCaptchaTab){
                    this.clearMark();
                    try { GM_setValue('mrp_cap_ts', 0); } catch(e){}
                    // Set resume flag BEFORE closing — dashboard page load will read it
                    try { GM_setValue(CAP_RESUME, '1'); } catch(e){}
                    sessionStorage.removeItem('mrp_cap_tab');
                    setTimeout(function(){
                        try { window.close(); } catch(e){}
                        // If window.close() didn't work, navigate back to dashboard
                        setTimeout(function(){ try { location.href = 'https://worker.mturk.com/dashboard'; } catch(e){} }, 500);
                    }, 800);
                    return;
                }
                // Same-page solve (no separate tab) — call autoResume directly
                autoResume();
            },
            startResumeWatch: function(){
                var s = this; this.stopResumeWatch();
                this.resumeTimer = setInterval(function(){
                    try { if ((parseInt(GM_getValue('mrp_cap_ts', '0')) || 0) === 0){ s.stopResumeWatch(); autoResume(); } } catch(e){}
                }, 1000);
            },
            stopResumeWatch: function(){ if (this.resumeTimer){ clearInterval(this.resumeTimer); this.resumeTimer = null; } },
            openTab: function(){
                if (this.captchaActive) return;
                this.captchaActive = true; this.markSeen(); this.playAlert();
                // Save resume signal to dedicated key — immune to startScan's WAS_RUNNING reset
                try { GM_setValue(CAP_RESUME, '1'); } catch(e){}
                try { GM_setValue(WAS_RUNNING, runtime.isRunning ? '1' : '0'); } catch(e){}
                state.wasRunning = runtime.isRunning;
                if (runtime.isRunning){ runtime.isRunning = false; runtime.startTime = null; stopAllTimers(); stopReloadTimer(); }
                try { GM_notification({ title: 'CAPTCHA!', text: 'Solve to auto-resume', timeout: 30000 }); } catch(e){}
                try {
                    var w = window.open('https://worker.mturk.com/dashboard?mrp_cap=1&_=' + now());
                    if (!w) location.href = 'https://worker.mturk.com/dashboard?mrp_cap=1';
                } catch(e){ location.href = 'https://worker.mturk.com/dashboard?mrp_cap=1'; }
                this.startRepeating(); this.showOverlay(); this.startResumeWatch();
                updateToggleBtn(); updateStatusDisplay();
            },
            startProbe: function(){
                var s = this; this.stopProbe();
                // v25.4: track the initial setTimeout handle so stopProbe can cancel
                // it. Without this, fast start/stop cycles leak delayed probes.
                this.probeInitTimer = setTimeout(function(){
                    s.probeInitTimer = null;
                    if (runtime.isRunning) s.probe();
                }, 60000);
                this.probeTimer = setInterval(function(){ s.probe(); }, s.probeInterval);
            },
            stopProbe: function(){
                if (this.probeTimer){ clearInterval(this.probeTimer); this.probeTimer = null; }
                if (this.probeInitTimer){ clearTimeout(this.probeInitTimer); this.probeInitTimer = null; }
            },
            probe: function(){
                if (this.captchaActive || this.isCaptchaTab) return;
                var n = now(); if (n - this.lastProbe < 300000) return; this.lastProbe = n;
                var s = this;
                GM_xmlhttpRequest({
                    method: 'GET', url: 'https://worker.mturk.com/dashboard?_=' + now(),
                    headers: { 'Accept': 'text/html', 'Cache-Control': 'no-cache' }, timeout: 15000,
                    onload: function(r){
                        if (s.hasCaptchaInText(r.responseText || '') || /captcha/i.test(r.finalUrl || '')) s.openTab();
                        else log('Probe OK', 'info');
                    },
                    onerror: function(){}, ontimeout: function(){}
                });
            },
            initPage: function(){
                var s = this, href = location.href;
                if (href.indexOf('mrp_cap=1') > -1){
                    this.isCaptchaTab = true;
                    sessionStorage.setItem('mrp_cap_tab', '1');
                    try { history.replaceState(null, '', href.replace(/[?&]mrp_cap=1/, '').replace(/[?&]_=\d+/, '')); } catch(e){}
                }
                if (sessionStorage.getItem('mrp_cap_tab') === '1') this.isCaptchaTab = true;

                // v25.4: guard against double-attach. With @run-at document-end the
                // body usually exists already, so the synchronous onReady() runs;
                // if DOMContentLoaded then fires later we'd start two scan intervals.
                var _readyDone = false;
                function onReady(){
                    if (_readyDone) return;
                    if (!document.body) return;
                    _readyDone = true;
                    if (s.isCaptchaTab){
                        if (s.hasCaptchaOnPage()){ s.showOverlay(); s.startRepeating(); s.startSolveMonitor(); }
                        else setTimeout(function(){
                            if (s.hasCaptchaOnPage()){ s.showOverlay(); s.startRepeating(); s.startSolveMonitor(); }
                            else {
                                s.clearMark();
                                try { GM_setValue('mrp_cap_ts', 0); } catch(e){}
                                sessionStorage.removeItem('mrp_cap_tab');
                                try { window.close(); } catch(e){}
                                setTimeout(function(){ try { location.href = 'https://worker.mturk.com/dashboard'; } catch(e){} }, 500);
                            }
                        }, 2000);
                        return;
                    }
                    setInterval(function(){
                        if (s.hasCaptchaOnPage() && !s.captchaActive){
                            s.captchaActive = true; s.markSeen(); s.showOverlay(); s.startRepeating(); s.startSolveMonitor();
                            var wasRun = runtime.isRunning;
                            try { GM_setValue(CAP_RESUME, '1'); } catch(e){}
                            try { GM_setValue(WAS_RUNNING, wasRun ? '1' : '0'); } catch(e){}
                            state.wasRunning = wasRun;
                            if (wasRun){ runtime.isRunning = false; runtime.startTime = null; stopAllTimers(); stopReloadTimer(); }
                            updateToggleBtn(); updateStatusDisplay();
                        }
                    }, 2000);
                }
                if (document.body) onReady();
                document.addEventListener('DOMContentLoaded', onReady);
            }
        };
        captchaSystem.initPage();

        // Server busy auto-dismiss
        (function(){
            function ck(){
                if (!document.body) return false;
                if ((document.title || '').toLowerCase().indexOf('server busy') > -1 || (document.body.innerText || '').indexOf('Continue shopping') > -1){
                    var els = document.querySelectorAll('input[type="submit"],button,a');
                    for (var i = 0; i < els.length; i++){
                        if ((els[i].textContent || els[i].value || '').indexOf('Continue') > -1){
                            try { els[i].click(); } catch(e){} break;
                        }
                    }
                    setTimeout(function(){ try { window.close(); } catch(e){ location.href = 'https://worker.mturk.com/dashboard'; } }, 1000);
                    return true;
                }
                return false;
            }
            if (document.body) ck();
            document.addEventListener('DOMContentLoaded', ck);
        })();

        if (captchaSystem.isCaptchaTab) return;

        // ================================================================
        //  DEFAULT BLOCKED REQUESTERS
        // ================================================================
        var DEFAULT_BLOCKED = [
            {id:'',name:'Shopping Receipts'},
            {id:'',name:'Pulsar'},
            {id:'',name:'Ben Peterson'},
            {id:'',name:'ooga.io'},
            {id:'',name:'James Billings'},
            {id:'',name:'StudyLab'},
            {id:'',name:'yang'},
            {id:'',name:'Andres'},
            {id:'',name:'GResearch'},
            {id:'',name:'Fraud Detection'},
            {id:'',name:'Darren Projects'},
            {id:'',name:'UserBob'},
            {id:'',name:'PTreutlein'},
            {id:'024848462088',name:'024848462088'},
            {id:'',name:'ProductPinion'},
            {id:'',name:'celicoo'},
            {id:'',name:'Okuma'},
            {id:'37BBAMQGASFDZNWB',name:'37BBAMQGASFDZNWB'},
            {id:'D9C04CDBWJFTCE',name:'D9C04CDBWJFTCE'},
            {id:'',name:'Search Research'},
            {id:'',name:'On A Lead'},
            {id:'',name:'Fashion Product Matching'},
            {id:'',name:'S@T'},
            {id:'',name:'Positly'},
            {id:'',name:'Data Intelligence Systems Lab'},
            {id:'',name:'Robert Parham'},
            {id:'',name:'Social Nature'},
            {id:'',name:'BigOven'},
            {id:'',name:'TeamZ'}
        ];

        // ================================================================
        //  STATE
        // ================================================================
        var state = {
            wasRunning: false, panelVisible: true, darkMode: true,
            // VACUUM always ON — accepts ALL HITs including $0 — never filter by reward
            minReward: 0, scanDelay: 0, parallelScanners: 14,
            connectionWarm: true, watchList: [], blockedRequesters: [],
            captchaProbeEnabled: true, captchaProbeMinutes: 10,
            acceptedHITs: [], activityLog: [], favoriteMode: false, favoriteHIT: null,
            favoriteFocusInterval: 30, autoStartEnabled: true,
            megaActive: false,
            sectionsCollapsed: {
                favoriteSection: true,
                captchaSection: false, blockUnblock: true, tools: true, activityLog: false,
            }
        };

        var runtime = {
            isRunning: false, acceptedCount: 0, scannedCount: 0, attemptCount: 0,
            startTime: null, serverBusyCount: 0, lastMinuteAccepts: [], scanSpeed: 0,
            consecutiveErrors: 0, favAcceptCount: 0, favAttemptCount: 0, queueSize: 0, queueFree: 25
        };

        var scannerTimers = [], favoriteTimer = null, groupTimers = {}, uptimeTimer = null;
        var warmTimer = null, watchdogTimer = null, panelClockTimer = null;
        var reloadTimer = null, reloadCountdown = 60;
        var rateLimitUntil = 0, rateLimitHistory = [], pendingAccepts = 0, pendingTimestamps = {};
        var saveDebounce = null, knownRequesters = {}, queuedGroupIds = {};
        var queuedGroupTimestamps = {}; // gid → update-time when blocked (re-post detection)
        var lastQueueSync = 0, lastScanTime = 0, syncRunning = false, _lastBatchPrune = 0; // v25.1
        var acceptedRecently = {}, acceptLocks = {};
        // batchGroupIds: tracks HITs with >100 slots — these bypass queuedGroupIds gate
        // when queue has free slots, allowing the queue to be filled fully from one batch
        var batchGroupIds = {};
        // v25.4: per-gid accept counter so the batch catcher can detect "this
        // specific batch stopped producing accepts" instead of "no HIT anywhere
        // got accepted in 600ms" (which is wrong when other scanners are firing).
        var acceptCountByGid = {};
        var _megaWasRunning = false; // v24.8: tracks whether scan was running BEFORE MEGA-ON so MEGA-OFF can resume correctly

        // Qualification filtering removed — was silently causing missed HITs.
        // All HITs blast at full power. MTurk returns 422 if not qualified.

        // ================================================================
        //  429 AUTO-RELOAD — fires when 429 count hits threshold
        //  BUG FIX: was calling reloadDashboardList before syncQueue finished
        // ================================================================
        var RL_RELOAD_THRESHOLD = 100;
        var lastRLReload = 0;

        function check429AutoReload(){
            if (runtime.serverBusyCount < RL_RELOAD_THRESHOLD) return;
            var n = now();
            if (n - lastRLReload < 30000) return; // 30s cooldown
            lastRLReload = n;
            log('429s hit ' + runtime.serverBusyCount + ' — resetting & syncing queue', 'warning');
            runtime.serverBusyCount = 0;
            var el = document.getElementById('mrp-busy-count');
            if (el){ el.textContent = '0'; el.style.color = ''; }
            // FIX: syncQueue first, then update display — not the other way round
            syncQueue(function(){
                log('Queue synced after 429 reset', 'success');
                updateStatusDisplay();
            });
        }

        // ================================================================
        //  MEGA GLOBAL — shared across all tabs via GM_setValue
        //  Any tab can read/write this key. All tabs poll it in watchdog.
        // ================================================================
        var _megaCached = false, _megaCacheTs = 0; // v25.1: cached MEGA state
        function isMegaGlobalOn(){
            var t = now();
            if (t - _megaCacheTs < 500){ return _megaCached; } // v25.1: 500ms cache
            try { _megaCached = GM_getValue(MEGA_GLOBAL_KEY, '0') === '1'; } catch(e){ _megaCached = false; }
            _megaCacheTs = t;
            return _megaCached;
        }
        function refreshMegaCache(){ _megaCacheTs = 0; } // v25.1: force cache refresh
        function setMegaGlobal(on){
            try { GM_setValue(MEGA_GLOBAL_KEY, on ? '1' : '0'); } catch(e){}
            // Also push to cross-browser sync
            if (SYNC_API_URL) writeSyncSignal(on ? 'MEGA_ON' : 'MEGA_OFF');
        }

        // ── CROSS-BROWSER SYNC ──
        // lastSyncSignal: last value read for THIS team — prevents acting on same signal twice
        // Keyed per-team so Team N and Team M tracking never interfere
        var lastSyncSignal = {};

        function writeSyncSignal(val){
            if (!SYNC_API_URL || !_teamKey || _teamKey === 'DEFAULT') return;
            GM_xmlhttpRequest({
                method: 'GET',
                url: SYNC_API_URL + '?action=set&type=signal&team=' + encodeURIComponent(_teamKey) + '&val=' + encodeURIComponent(val) + '&_=' + now(),
                headers: { 'Cache-Control': 'no-cache' },
                timeout: 8000,
                onload: function(){},
                onerror: function(){}
            });
        }

        function readSyncSignal(cb){
            if (!SYNC_API_URL || !_teamKey || _teamKey === 'DEFAULT'){ cb(null); return; }
            GM_xmlhttpRequest({
                method: 'GET',
                url: SYNC_API_URL + '?action=get&type=signal&team=' + encodeURIComponent(_teamKey) + '&_=' + now(),
                headers: { 'Cache-Control': 'no-cache, no-store' },
                timeout: 8000,
                onload: function(r){
                    var val = (r.responseText || '').trim();
                    // Accept RUN, STOP, MEGA_ON, MEGA_OFF — all valid cross-browser signals
                    var valid = ['RUN','STOP','MEGA_ON','MEGA_OFF'];
                    cb(valid.indexOf(val) > -1 ? val : null);
                },
                onerror:   function(){ cb(null); },
                ontimeout: function(){ cb(null); }
            });
        }

        function getGlobalRun(){
            try { return GM_getValue('mrp_run_' + _teamKey, ''); } catch(e){ return ''; }
        }
        function setGlobalRun(on){
            try { GM_setValue('mrp_run_' + _teamKey, on ? '1' : '0'); } catch(e){}
            // Push to cross-browser sync API — team-scoped
            writeSyncSignal(on ? 'RUN' : 'STOP');
        }

        // ── TEAM MIN REWARD SYNC ──
        // Works exactly like start/stop:
        //   GM_setValue          → instant same-browser sync (every 2s, no network)
        //   Apps Script type=reward → cross-browser sync (every 3s, same timing as RUN/STOP)
        var lastSyncedReward = -1;
        var _tabStartTime = now(); // used to reject stale reward signals from old sessions

        function writeRewardSignal(dollars){
            // Same-browser: store as 'timestamp|dollars' so receivers can reject stale old-session values
            try { GM_setValue('mrp_reward_' + _teamKey, now() + '|' + dollars.toFixed(2)); } catch(e){}
            // Cross-browser: Apps Script with type=reward slot (separate from signal slot)
            if (!SYNC_API_URL || !_teamKey || _teamKey === 'DEFAULT') return;
            GM_xmlhttpRequest({
                method: 'GET',
                url: SYNC_API_URL + '?action=set&type=reward&team=' + encodeURIComponent(_teamKey) + '&val=' + encodeURIComponent(dollars.toFixed(2)) + '&_=' + now(),
                headers: { 'Cache-Control': 'no-cache' },
                timeout: 8000,
                onload: function(){}, onerror: function(){}
            });
        }

        function readRewardSignal(cb){
            if (!SYNC_API_URL || !_teamKey || _teamKey === 'DEFAULT'){ cb(null); return; }
            GM_xmlhttpRequest({
                method: 'GET',
                url: SYNC_API_URL + '?action=get&type=reward&team=' + encodeURIComponent(_teamKey) + '&_=' + now(),
                headers: { 'Cache-Control': 'no-cache, no-store' },
                timeout: 8000,
                onload: function(r){
                    var raw = (r.responseText || '').trim();
                    var num = parseFloat(raw);
                    cb(isNaN(num) || raw === '' ? null : num);
                },
                onerror: function(){ cb(null); },
                ontimeout: function(){ cb(null); }
            });
        }

        function applyTeamReward(dollars){
            if (dollars === null || isNaN(dollars)) return;
            dollars = Math.max(0, Math.min(100, dollars));
            if (Math.abs(dollars - state.minReward) < 0.005) return; // already at this value
            lastSyncedReward = dollars;
            state.minReward = dollars;
            saveState();
            var slEl = gel('mrp-min-reward'), tyEl = gel('mrp-min-type');
            if (slEl){
                slEl.value = Math.round(dollars * 100);
                var pct = (Math.round(dollars * 100) / 10000 * 100).toFixed(1);
                slEl.style.background = 'linear-gradient(to right,#2ecc71 ' + pct + '%,#222 ' + pct + '%)';
            }
            if (tyEl) tyEl.value = dollars.toFixed(2);
            log('💰 Team min reward: $' + dollars.toFixed(2), 'info');
        }

        function startRewardPoller(){
            if (!_teamKey || _teamKey === 'DEFAULT') return;
            var gmKey = 'mrp_reward_' + _teamKey;

            // Fast: same-browser GM poll every 2s (no network — same as run/stop fast poll)
            // Format: 'timestamp|dollars' — only apply if written AFTER this tab loaded.
            // This prevents stale values from previous sessions overriding the user's setting.
            setInterval(function(){
                try {
                    var raw = GM_getValue(gmKey, '');
                    if (!raw) return;
                    var parts = raw.split('|');
                    var ts = parseInt(parts[0]) || 0;
                    var dollars = parseFloat(parts[1]);
                    // Only apply if: (a) value was written after this tab loaded,
                    // AND (b) it's a valid number.
                    // This blocks stale 0.00 from a previous session zeroing out the filter.
                    if (isNaN(dollars)) return;
                    if (ts <= _tabStartTime) return; // stale — written before or at tab load
                    applyTeamReward(dollars);
                } catch(e){}
            }, 2000);

            // Cross-browser: Apps Script poll every 3s (same timing as run/stop)
            // Guard: only apply 0 if we have already seen a non-zero reward in this session.
            // This prevents a persisted 0.00 on the API from zeroing out a user's saved filter.
            var _crossBrowserRewardSeen = false;
            if (!SYNC_API_URL) return;
            setInterval(function(){
                readRewardSignal(function(dollars){
                    if (dollars === null) return;
                    if (dollars > 0) _crossBrowserRewardSeen = true;
                    // Don't apply 0 unless we've already seen a non-zero in this session
                    // (prevents stale 0.00 API value from zeroing user's saved filter on startup)
                    if (dollars === 0 && !_crossBrowserRewardSeen) return;
                    applyTeamReward(dollars);
                    // Propagate to same-browser tabs using new timestamped format
                    try { GM_setValue(gmKey, now() + '|' + dollars.toFixed(2)); } catch(e){}
                });
            }, 3000);
        }

        // ── TEAM BLOCKLIST SYNC ──
        // When any team member blocks a requester, the block propagates to all
        // IDs on the same team via Apps Script type=blocklist.
        var _lastBlockHash = '';

        function _blockHash(list){
            // Quick fingerprint of blocklist — used to detect changes
            // v25.3: __NOID__ prevents empty-ID hash collisions
            return (list||[]).filter(Boolean).map(function(b){ return (b.id||'__NOID__')+'|'+(b.name||'').toLowerCase().trim(); }).sort().join(',');
        }

        // v25.4: writeInFlight blocks the poller from acting on stale reads
        // until our POST has had time to propagate. Eliminates the race where a
        // freshly-added local block was wiped by an old remote read.
        var _blockWriteInFlight = 0; // timestamp until which the poller must ignore remote data
        function writeBlocklistSignal(){
            if (!SYNC_API_URL || !_teamKey || _teamKey === 'DEFAULT') return;
            // Store id+name only — keep payload small
            var compact = state.blockedRequesters.map(function(b){
                return { id: b.id || '', name: b.name || '' };
            }).slice(0, 60); // cap at 60 entries
            var val = JSON.stringify(compact);
            var localHash = _blockHash(compact);
            // Block poller for 12s — Apps Script + Google Sheet propagation can take ~5-10s
            _blockWriteInFlight = now() + 12000;
            // v25.2: POST to avoid Google Apps Script 2KB GET URL limit (60 entries can be 3-4KB)
            GM_xmlhttpRequest({
                method: 'POST',
                url: SYNC_API_URL + '?action=set&type=blocklist&team=' + encodeURIComponent(_teamKey) + '&_=' + now(),
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
                data: JSON.stringify({ val: val }),
                timeout: 8000,
                onload: function(){
                    // Only update _lastBlockHash AFTER confirmed POST — this prevents
                    // a stale remote read from matching the in-flight hash.
                    _lastBlockHash = localHash;
                },
                onerror: function(){
                    // POST failed — release the write lock so poller can sync again
                    _blockWriteInFlight = 0;
                }
            });
        }

        function readBlocklistSignal(cb){
            if (!SYNC_API_URL || !_teamKey || _teamKey === 'DEFAULT'){ cb(null); return; }
            GM_xmlhttpRequest({
                method: 'GET',
                url: SYNC_API_URL + '?action=get&type=blocklist&team=' + encodeURIComponent(_teamKey) + '&_=' + now(),
                headers: { 'Cache-Control': 'no-cache, no-store' },
                timeout: 8000,
                onload: function(r){
                    try {
                        var raw = (r.responseText || '').trim();
                        if (!raw || raw === '[]' || raw === 'null') { cb(null); return; }
                        cb(JSON.parse(raw));
                    } catch(e){ cb(null); }
                },
                onerror: function(){ cb(null); },
                ontimeout: function(){ cb(null); }
            });
        }

        function applyTeamBlocklist(list){
            // v25.3: guard empty list — [] response (API blip) must NOT wipe blocks
            if (!list || !list.length) return;
            // v25.4: block all reconciliation while a local POST is in flight.
            // The remote may still hold the pre-POST state and would otherwise
            // wipe the entry the user just added.
            if (now() < _blockWriteInFlight) return;
            var hash = _blockHash(list);
            if (hash === _lastBlockHash) return; // no change
            _lastBlockHash = hash;

            // v25.3 STEP 1: REMOVE entries no longer in team list (propagates unblocks)
            // 'default' entries are immune — only Restore Defaults can remove them
            var removedCount = 0;
            state.blockedRequesters = state.blockedRequesters.filter(function(local){
                if (local.blockedAt === 'default') return true;
                var stillInTeam = list.some(function(remote){
                    var idMatch   = local.id   && remote.id   && local.id   === remote.id;
                    var nameMatch = local.name && remote.name &&
                                   local.name.toLowerCase().trim() === remote.name.toLowerCase().trim();
                    return idMatch || nameMatch;
                });
                if (!stillInTeam){ removedCount++; return false; }
                return true;
            });

            // v25.3 STEP 2: ADD entries new in remote team list
            var addedCount = 0;
            list.forEach(function(b){
                if (!b.id && !b.name) return;
                var exists = state.blockedRequesters.some(function(x){
                    return (b.id && x.id && x.id === b.id) ||
                           (b.name && x.name && x.name.toLowerCase().trim() === b.name.toLowerCase().trim());
                });
                if (!exists){
                    state.blockedRequesters.push({ id: b.id||'', name: b.name||'', blockedAt: 'team-sync' });
                    addedCount++;
                }
            });

            if (addedCount > 0 || removedCount > 0){
                rebuildBlockSets(); saveState(); updateBlockedDisplay();
                var parts = [];
                if (addedCount   > 0) parts.push(addedCount   + ' added');
                if (removedCount > 0) parts.push(removedCount + ' removed');
                log('🚫 Team blocklist synced — ' + parts.join(', '), 'warning');
            }
        }

        function startBlocklistPoller(){
            if (!SYNC_API_URL || !_teamKey || _teamKey === 'DEFAULT') return;
            // READ team blocklist on startup — never WRITE on startup (would erase teammates' blocks)
            readBlocklistSignal(function(list){ applyTeamBlocklist(list); });
            // Poll every 10s — blocklist changes infrequently
            setInterval(function(){
                readBlocklistSignal(function(list){ applyTeamBlocklist(list); });
            }, 10000);
        }

        // ================================================================
        //  STOP ALL TIMERS
        // ================================================================
        function stopAllTimers(){
            for (var i = 0; i < scannerTimers.length; i++){
                if (scannerTimers[i] !== null){ clearTimeout(scannerTimers[i]); scannerTimers[i] = null; }
            }
            scannerTimers = [];
            if (uptimeTimer){ clearInterval(uptimeTimer); uptimeTimer = null; }
            stopGroupCatchers(); stopFavoriteCatcher(); stopWarm(); stopWatchdog();
            // Dashboard scanner removed — no call needed
            captchaSystem.stopProbe();
            pendingAccepts = 0; pendingTimestamps = {}; acceptLocks = {};
        }

        // ================================================================
        //  AUTO-RESUME — called after captcha is solved
        //  Uses dedicated CAP_RESUME flag (separate from WAS_RUNNING) so
        //  startScan()'s reset of WAS_RUNNING can never block resumption.
        // ================================================================
        function autoResume(){
            captchaSystem.captchaActive = false;
            captchaSystem.stopRepeating(); captchaSystem.stopResumeWatch();
            captchaSystem.removeOverlay(); captchaSystem.clearMark();
            try { GM_setValue('mrp_cap_ts', 0); } catch(e){}
            // Check dedicated captcha resume flag — immune to startScan's WAS_RUNNING reset
            var shouldResume = false;
            try { shouldResume = GM_getValue(CAP_RESUME, '0') === '1'; } catch(e){}
            if (!shouldResume) shouldResume = state.wasRunning; // fallback
            try { GM_setValue(CAP_RESUME, '0'); } catch(e){}  // clear the flag
            updateToggleBtn(); updateStatusDisplay();
            if (!runtime.isRunning){
                if (shouldResume){
                    log('✓ CAPTCHA solved — auto-resuming in 1s...', 'success');
                    setTimeout(startScan, 1000);
                } else {
                    log('CAPTCHA solved — scan was stopped, not resuming', 'info');
                }
            }
        }

        // ================================================================
        //  PERSISTENCE
        //  FIX: activityLog was capped at 80 on save but allowed 400 in memory;
        //       now consistent. Also added version tag to detect old saves.
        // ================================================================
        function saveState(){ if (saveDebounce) clearTimeout(saveDebounce); saveDebounce = setTimeout(doSave, 250); }
        function doSave(){
            try {
                var keys = ['wasRunning','panelVisible','darkMode','minReward',
                    'parallelScanners','connectionWarm','watchList','blockedRequesters',
                    'captchaProbeEnabled','captchaProbeMinutes',
                    'favoriteMode','favoriteHIT','favoriteFocusInterval','autoStartEnabled','sectionsCollapsed','megaActive'];
                var obj = { _v: VERSION };
                for (var i = 0; i < keys.length; i++) obj[keys[i]] = state[keys[i]];
                obj.wasRunning = runtime.isRunning;
                obj.acceptedHITs = state.acceptedHITs.slice(0, 60);
                obj.activityLog = state.activityLog.slice(0, 80);
                GM_setValue(STORAGE_KEY, JSON.stringify(obj));
            } catch(e){}
        }
        function saveNow(){ if (saveDebounce) clearTimeout(saveDebounce); doSave(); }

        // Pre-built block lookup sets — rebuilt whenever blockedRequesters changes.
        // Avoids repeated toLowerCase/trim on every HIT seen during hot scan loop.
        var _blockedIds   = {};  // requesterId → true  (O(1) lookup)
        var _blockedNames = [];  // [{bn, len}] pre-lowercased
        function rebuildBlockSets(){
            _blockedIds = {};
            _blockedNames = [];
            state.blockedRequesters.forEach(function(b){
                if (b.id && b.id.length > 0) _blockedIds[b.id] = true;
                if (b.name && b.name.trim().length >= 1){
                    _blockedNames.push({ bn: b.name.toLowerCase().trim(), len: b.name.trim().length });
                }
            });
        }

        function ensureBlocked(){
            DEFAULT_BLOCKED.forEach(function(def){
                var found = state.blockedRequesters.some(function(b){
                    return (def.name && b.name && def.name.toLowerCase() === b.name.toLowerCase()) ||
                           (def.id && def.id.length > 0 && b.id === def.id);
                });
                if (!found) state.blockedRequesters.push({ id: def.id, name: def.name, blockedAt: 'default' });
            });
            rebuildBlockSets();
        }

        function loadState(){
            try {
                var raw = GM_getValue(STORAGE_KEY, '') || GM_getValue('mrp_v13_2', '') || GM_getValue('mrp_v13_1', '');
                if (!raw){ ensureBlocked(); saveNow(); return; }
                var s = JSON.parse(raw);
                // Only restore user-facing preferences — engine/perf settings forced below
                var userKeys = ['panelVisible','darkMode','watchList','blockedRequesters',
                    // savedGroups/requesterPresets/valueFilters/activeValueFilter — no longer saved
                    'captchaProbeEnabled','captchaProbeMinutes','favoriteMode','favoriteHIT',
                    'favoriteFocusInterval','autoStartEnabled','sectionsCollapsed','minReward',
                    'acceptedHITs','activityLog','wasRunning','megaActive'];
                for (var i = 0; i < userKeys.length; i++){
                    if (s[userKeys[i]] !== undefined){
                        // Deep-merge sectionsCollapsed so new sections in updates keep their default
                        if (userKeys[i] === 'sectionsCollapsed' && typeof s[userKeys[i]] === 'object'){
                            var _sc = s[userKeys[i]];
                            Object.keys(_sc).forEach(function(k){ state.sectionsCollapsed[k] = _sc[k]; });
                        } else {
                            state[userKeys[i]] = s[userKeys[i]];
                        }
                    }
                }
                ensureBlocked(); rebuildBlockSets();
            } catch(e){ ensureBlocked(); rebuildBlockSets(); }
            // Force engine settings — old saves must NEVER override these
            // minReward is a USER setting — NOT forced, respects saved preference
            state.scanDelay        = 20;    // v25.3: 20ms — faster for low-latency connections
            state.parallelScanners = 12;    // v25.3: 12 scanners — 2 extra, still under 429 thresholdqualified + page2 + page3
            state.connectionWarm   = true;
            // favoriteFocusInterval is a user preference — NOT forced, respects saved value
        }
        window.addEventListener('beforeunload', saveNow);

        // ================================================================
        //  HELPERS
        // ================================================================
        function classifyId(id){
            if (!id) return 'unknown'; id = id.trim();
            if (/^A[A-Z0-9]{9,19}$/i.test(id)) return 'requester';
            if (/^[0-9A-Z]{20,}$/i.test(id)) return 'group';
            return 'unknown';
        }
        function extractId(inp){
            if (!inp) return ''; inp = inp.trim(); var m;
            m = inp.match(/\/projects\/([A-Z0-9]+)/i); if (m) return m[1];
            m = inp.match(/\/requesters\/([A-Z0-9]+)/i); if (m) return m[1];
            m = inp.match(/groupId=([A-Z0-9]+)/i); if (m) return m[1];
            m = inp.match(/hit_set_id=([A-Z0-9]+)/i); if (m) return m[1];
            return inp.replace(/\s+/g, '');
        }
        // blockedGroupIds: populated when JSON scanner sees a blocked requester's HIT.
        // Prevents dashboard scanner (which has no requester info) from accepting them.
        var blockedGroupIds = {};
        var blockedGroupIdsAge = 0; // timestamp of last clear

        function isBlocked(rid, rn){
            // O(1) ID check using pre-built set
            if (rid && _blockedIds[rid]) return true;
            if (!rn) return false;
            var rnn = rn.toLowerCase().trim();
            for (var _i = 0; _i < _blockedNames.length; _i++){
                var _e = _blockedNames[_i];
                if (_e.bn === rnn) return true;
                if (_e.len >= 4 && rnn.indexOf(_e.bn) > -1) return true;
            }
            return false;
        }
        function blockRequester(rid, rn){
            if (!rid && !rn) return;
            var dup = state.blockedRequesters.some(function(b){
                return (b.id && rid && b.id === rid) || (b.name && rn && b.name.toLowerCase() === rn.toLowerCase());
            });
            if (dup){ log('Already blocked', 'warning'); return; }
            state.blockedRequesters.push({ id: rid || '', name: rn || '', blockedAt: new Date().toLocaleDateString() });
            // Immediately mark all known groupIds from this requester as blocked
            // so fireAccept stops accepting them right now — no waiting for next scan
            state.acceptedHITs.forEach(function(h){
                if ((rid && h.requesterId === rid) || (rn && h.requester && h.requester.toLowerCase() === rn.toLowerCase())){
                    if (h.id) blockedGroupIds[h.id] = true;
                }
            });
            saveState(); rebuildBlockSets(); updateBlockedDisplay(); updateAcceptedDisplay();
            log('Blocked: ' + (rn || rid), 'warning');
            // Propagate block to all team members via Apps Script
            writeBlocklistSignal();
        }
        function getUptime(){
            if (!runtime.startTime) return '—';
            var d = now() - runtime.startTime, s = Math.floor(d / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
            return h > 0 ? h + 'h' + (m % 60) + 'm' : m > 0 ? m + 'm' + (s % 60) + 's' : s + 's';
        }
        function esc(s){
            if (!s) return '';
            // v25.4: createTextNode + innerHTML escapes <, >, & — but NOT " or '.
            // Several call sites embed esc() output into HTML attributes
            // (data-rid, data-rn, value=). Without escaping " a requester name
            // containing a double-quote would break out of the attribute.
            var d = document.createElement('div');
            d.appendChild(document.createTextNode(String(s)));
            return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        function gel(id){ return document.getElementById(id); }
        function getHPM(){
            var n = now();
            runtime.lastMinuteAccepts = runtime.lastMinuteAccepts.filter(function(t){ return n - t < 60000; });
            return runtime.lastMinuteAccepts.length;
        }
        function addToWatch(id, type, label){
            id = extractId(id); if (!id) return;
            type = type || classifyId(id);
            if (state.watchList.some(function(w){ return w.id === id; })){ log('Already watching', 'warning'); return; }
            state.watchList.push({ id: id, type: type, label: label || '' });
            saveState(); updateWatchList();
            log('+ [' + type.toUpperCase() + '] ' + id.substring(0, 16), 'success');
            if (runtime.isRunning && type === 'group') startOneGroup(id);
            rebuildUrlPatterns();
        }
        function log(msg, type){
            type = type || 'info';
            state.activityLog.unshift({ message: msg, type: type, time: new Date().toLocaleTimeString() });
            if (state.activityLog.length > 400) state.activityLog.length = 400;
            updateLogDisplay();
        }
        function getCSRF(){
            try { var m = document.querySelector('meta[name="csrf_token"]'); if (m && m.content) return m.content; } catch(e){}
            return '';
        }

        // ================================================================
        //  SOUND — Rich Piano with layered harmonics
        //  Real piano tone = sine wave fundamental + overtones (2x, 3x freq)
        //  Each harmonic decays at different rate — higher partials fade faster.
        //  Loud, clear, unmistakable piano sound on every accepted HIT.
        // ================================================================
        var audioCtx = null;
        function getAudioCtx(){
            if (!audioCtx || audioCtx.state === 'closed'){
                try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){ return null; }
            }
            if (audioCtx.state === 'suspended') try { audioCtx.resume(); } catch(e){}
            return audioCtx;
        }

        function playPartial(ctx, freq, vol, decaySec, t0){
            try {
                var osc = ctx.createOscillator();
                var g   = ctx.createGain();
                osc.connect(g); g.connect(ctx.destination);
                osc.type = 'sine';
                osc.frequency.value = freq;
                g.gain.setValueAtTime(0, t0);
                g.gain.linearRampToValueAtTime(vol, t0 + 0.008);
                g.gain.exponentialRampToValueAtTime(0.001, t0 + decaySec);
                osc.start(t0); osc.stop(t0 + decaySec + 0.05);
            } catch(e){}
        }

        function pianoNote(freq, vol, delayMs){
            var ctx = getAudioCtx(); if (!ctx) return;
            var doPlay = function(){
                var t = ctx.currentTime + (delayMs || 0) / 1000;
                playPartial(ctx, freq,       vol,        1.4, t);  // fundamental — loudest, longest
                playPartial(ctx, freq * 2,   vol * 0.6,  0.7, t);  // 2nd harmonic
                playPartial(ctx, freq * 3,   vol * 0.3,  0.35,t);  // 3rd harmonic — fades fast
                playPartial(ctx, freq * 4,   vol * 0.15, 0.18,t);  // 4th harmonic — brief brightness
            };
            if (ctx.state === 'suspended'){ ctx.resume().then(doPlay).catch(function(){}); } else { doPlay(); }
        }

        // Low reward (<$0.05): single C5 — one clear note
        function playSoundLow(){
            pianoNote(523, 0.75, 0);
        }

        // High reward (>=$0.05): C-E-G major arpeggio — cheerful chord
        function playSoundHigh(){
            pianoNote(523, 0.80,   0);   // C5
            pianoNote(659, 0.75, 130);   // E5
            pianoNote(784, 0.70, 260);   // G5
        }

        // Favorite HIT: C-E-G-C victory fanfare — loud and unmistakable
        function playSoundFav(){
            pianoNote(523,  0.85,   0);  // C5
            pianoNote(659,  0.80, 120);  // E5
            pianoNote(784,  0.80, 240);  // G5
            pianoNote(1047, 0.95, 390);  // C6 — full volume octave finish
        }

        function preFetchSounds(){
            var unlock = function(){
                var ctx = getAudioCtx();
                if (ctx && ctx.state === 'suspended') ctx.resume();
            };
            document.addEventListener('click',      unlock, true);
            document.addEventListener('mousedown',  unlock, true);
            document.addEventListener('keydown',    unlock, true);
            document.addEventListener('touchstart', unlock, true);
        }

        function playRewardSound(r){
            var cents = 0;
            try { cents = Math.round(parseFloat(r) * 100); } catch(e){}
            if (cents < 5) playSoundLow(); else playSoundHigh();
        }
        function playFavSound(){ playSoundFav(); }

        // ================================================================
        //  RATE LIMITER
        //  FIX: rateLimitHistory was unbounded — old entries never cleaned from
        //       main array, only from the filter. Fixed with a proper sliding window.
        // ================================================================
        function recordRateLimit(){
            var n = now();
            rateLimitHistory.push(n);
            // Keep only last 30 entries, prune those older than 20s
            while (rateLimitHistory.length > 30) rateLimitHistory.shift();
            var recent = rateLimitHistory.filter(function(t){ return n - t < 20000; });
            rateLimitUntil = n + (recent.length >= 8 ? 6000 : recent.length >= 5 ? 2500 : recent.length >= 3 ? 1000 : 400);
            runtime.serverBusyCount++;
            check429AutoReload();
        }
        function isRateLimited(){ return now() < rateLimitUntil; }
        function getRLWait(){ return Math.max(0, rateLimitUntil - now()); }

        // ================================================================
        //  QUEUE SYNC
        //  Fix: running flag prevents 4 scanners firing simultaneously.
        //  Fix: queuedGroupIds is MERGED not wiped — recent accepts preserved.
        // ================================================================
        function syncQueue(cb){
            // v25.0 FIX: never allow concurrent syncs — queue callback for later
            if (syncRunning){
                if (cb) setTimeout(function(){ syncQueue(cb); }, 500);
                return;
            }
            syncRunning = true;
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://worker.mturk.com/tasks.json?page_size=25&_=' + now(),
                headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                timeout: 8000,
                onload: function(r){
                    syncRunning = false;
                    if (r.status === 200){
                        try {
                            var data = JSON.parse(r.responseText);
                            var tasks = data.tasks || data.assignments || data.results || [];
                            runtime.queueSize = data.num_tasks_available || data.total_num_results || data.total || tasks.length;
                            runtime.queueFree = Math.max(0, 25 - runtime.queueSize);
                            // Build live set from MTurk response
                            var liveSet = {};
                            tasks.forEach(function(t){
                                var gid = t.hit_set_id || t.project_id || '';
                                if (!gid) try { gid = t.project.hit_set_id; } catch(e){}
                                if (gid) liveSet[gid] = true;
                            });
                            // MERGE: remove only stale entries (not in live set AND not recently accepted)
                            // Never wipe an entry that was just accepted in the last 10s
                            Object.keys(queuedGroupIds).forEach(function(gid){
                                if (!liveSet[gid] && !acceptedRecently[gid]) delete queuedGroupIds[gid];
                            });
                            // syncQueue only CLEARS stale entries — does NOT re-populate.
                            // onAccepted is the only writer. Re-populating blocked multi-slot HITs.
                        } catch(e){ if (runtime.queueFree <= 0) runtime.queueFree = 5; }
                    } else {
                        if (runtime.queueFree <= 0) runtime.queueFree = 5;
                    }
                    lastQueueSync = now();
                    if (cb) cb();
                },
                onerror: function(){ syncRunning = false; if (runtime.queueFree <= 0) runtime.queueFree = 5; lastQueueSync = now(); if (cb) cb(); },
                ontimeout: function(){ syncRunning = false; if (runtime.queueFree <= 0) runtime.queueFree = 5; lastQueueSync = now(); if (cb) cb(); }
            });
        }

        // ================================================================
        //  ACCEPT DETECTION
        //  FIX: Added more rejection phrases MTurk uses in 2024/2025
        // ================================================================
        function detectAccept(status, body, furl){
            var r = { accepted: false, assignId: '', confidence: 0 };
            if (status === 422 || status === 404 || status === 429 || status === 503) return r;
            var bl = (body || '').toLowerCase();
            var fu = (furl || '').toLowerCase();
            var rejects = [
                'no more available hits','no hits available','there are no more',
                'already accepted the maximum','you have already accepted',
                'continue shopping','this hit is no longer available',
                'you are not qualified','this group has no more',
                'this hit has been deleted','hit is no longer available',
                'maximum assignments','you\'ve already accepted'
            ];
            if (rejects.some(function(x){ return bl.indexOf(x) > -1; })) return r;
            // FIX: Redirect to /tasks/ URL (not accept_random) = definitive accept
            if (fu.indexOf('/tasks/') > -1 && fu.indexOf('accept_random') === -1){
                var m2 = (furl || '').match(/\/tasks\/([A-Z0-9]{20,})/i);
                r.accepted = true; r.assignId = m2 ? m2[1] : ''; r.confidence = 100; return r;
            }
            var m = (furl || '').match(/assignment_id=([A-Z0-9]+)/i);
            if (m){ r.accepted = true; r.assignId = m[1]; r.confidence = 100; return r; }
            m = (furl || '').match(/\/tasks\/([A-Z0-9]{20,})/i);
            if (m){ r.accepted = true; r.assignId = m[1]; r.confidence = 95; return r; }
            if (body && body.length > 500){
                var pats = [
                    /name="assignmentId"\s*value="([A-Z0-9]{20,})"/i,
                    /"assignmentId"\s*:\s*"([A-Z0-9]{20,})"/i,
                    /assignmentId=([A-Z0-9]{20,})/i
                ];
                for (var p = 0; p < pats.length; p++){
                    m = body.match(pats[p]);
                    if (m){ r.accepted = true; r.assignId = m[1]; r.confidence = 85; return r; }
                }
            }
            if (body && body.length > 3000){
                var markers = ['id="thetask"','id="hit-wrapper"','externalsubmit','mturk_form','id="taskcontentbody"','crowd-form'];
                if (markers.filter(function(x){ return bl.indexOf(x) > -1; }).length >= 2){
                    r.accepted = true; r.confidence = 75; return r;
                }
            }
            return r;
        }

        // ================================================================
        //  FIRE ACCEPT — fires N blasts for a single HIT
        //  `resolved` flag is the real early-exit guard — the instant any
        //  blast succeeds, resolved=true and all subsequent callbacks
        //  discard their results immediately (if (resolved) return).
        //  GM_xmlhttpRequest cannot be cancelled mid-flight, but the
        //  resolved flag ensures results are discarded after first success.
        // ================================================================
        function fireAccept(groupId, hitInfo, blastCount){
            if (!runtime.isRunning || captchaSystem.captchaActive) return;
            // Never block the active favorite HIT — user explicitly chose it
            var isFavTarget = state.favoriteMode && state.favoriteHIT && state.favoriteHIT.groupId === groupId;
            if (blockedGroupIds[groupId] && !isFavTarget) return;

            var isBatch = !!batchGroupIds[groupId];
            // Favorite HIT is ALWAYS re-acceptable — never blocked by queuedGroupIds
            var isFav = state.favoriteMode && state.favoriteHIT && state.favoriteHIT.groupId === groupId;

            if (isBatch || isFav){
                if (acceptLocks[groupId] || acceptedRecently[groupId] || pendingAccepts >= 500) return; // v25.0: raised cap
            } else {
                if (queuedGroupIds[groupId] || acceptedRecently[groupId] ||
                    acceptLocks[groupId] || pendingAccepts >= 500) return; // v25.0: raised cap
            }

            blastCount = Math.max(1, Math.min(200, blastCount || 3));
            acceptLocks[groupId] = true;
            var resolved = false;
            var baseUrl = 'https://worker.mturk.com/projects/' + groupId + '/tasks/accept_random';

            function onSucc(body, furl, respUrl){
                if (resolved) return;

                var bl = (body || '').toLowerCase();
                var fu = (furl    || '').toLowerCase();
                var ru = (respUrl || '').toLowerCase();

                // TIER 1: redirect to /tasks/ — DEFINITIVE accept for ALL HIT types.
                // The only fully reliable signal — body parsing is fallback.
                if ((fu.indexOf('/tasks/') > -1 && fu.indexOf('accept_random') === -1) ||
                    (ru.indexOf('/tasks/') > -1 && ru.indexOf('accept_random') === -1)){
                    resolved = true; cancelSiblingBlasts(); delete acceptLocks[groupId];
                    onAccepted(groupId, hitInfo, '');
                    return;
                }

                // v25.4: body-content tiers must FIRST verify the body is NOT a known
                // rejection page. MTurk error pages can contain marker substrings
                // (e.g. crowd-form in nav, "assignment_id" in JS configs) which would
                // cause false-positive accepts. Reject-phrase pre-check eliminates this.
                var rejectPhrases = [
                    'no more available hits','no hits available','there are no more',
                    'already accepted the maximum','you have already accepted',
                    'continue shopping','this hit is no longer available',
                    'you are not qualified','this group has no more',
                    'this hit has been deleted','hit is no longer available',
                    'maximum assignments','you\'ve already accepted',
                    'opfcaptcha','validatecaptcha','captchacharacters'
                ];
                for (var rp = 0; rp < rejectPhrases.length; rp++){
                    if (bl.indexOf(rejectPhrases[rp]) > -1) return; // not accepted, leave resolved=false
                }

                // TIER 2: assignmentId in form (real task page artifact, very specific)
                if (bl.length > 1500 &&
                    (/name="assignmentid"\s+value="[a-z0-9]{10,}"/i.test(body || '') ||
                     /"assignment_id"\s*:\s*"[a-z0-9]{10,}"/i.test(body || ''))){
                    resolved = true; cancelSiblingBlasts(); delete acceptLocks[groupId];
                    onAccepted(groupId, hitInfo, '');
                    return;
                }

                // TIER 3: turkSubmitTo (external HIT iframe wrapper) + substantial body
                if (bl.length > 1500 && bl.indexOf('turksubmitto') > -1){
                    resolved = true; cancelSiblingBlasts(); delete acceptLocks[groupId];
                    onAccepted(groupId, hitInfo, '');
                    return;
                }

                // TIER 4: internal task DOM markers — both required to avoid nav-bar matches
                if (bl.length > 1500 &&
                    (bl.indexOf('crowd-form') > -1 && bl.indexOf('crowd-button') > -1)){
                    resolved = true; cancelSiblingBlasts(); delete acceptLocks[groupId];
                    onAccepted(groupId, hitInfo, '');
                    return;
                }

                // No match — leave resolved=false so other in-flight blasts can win.
            }

            function onFail(status, body){
                if (resolved) return;
                // 422 = not qualified / queue full / already accepted / rate limited
                // Do NOT activate captcha on 422 alone — that kills the entire script
                // for any HIT the user isn't qualified for.
                // Only activate captcha if the response body actually contains captcha HTML.
                if (captchaSystem.hasCaptchaInText(body || '')){
                    resolved = true;
                    delete acceptLocks[groupId];
                    captchaSystem.openTab();
                    return;
                }
                // 422 without captcha = not qualified or already taken — just skip silently
                if (status === 422) return;
                if (status === 429 || status === 503 || (body || '').indexOf('Continue shopping') > -1){
                    recordRateLimit();
                }
            }

            var blastsFired = 0, blastsSettled = 0;
            var blastControllers = []; // AbortControllers for each blast — cancel siblings on win
            function cancelSiblingBlasts(){
                blastControllers.forEach(function(c){ if (c) try { c.abort(); } catch(e){} });
            }
            for (var b = 0; b < blastCount; b++){
                (function(blastIdx){
                    if (resolved || pendingAccepts >= 500) return; // v25.0: raised cap
                    blastsFired++;
                    pendingAccepts++;
                    runtime.attemptCount++;
                    var pk = groupId + '_' + blastIdx + '_' + now();
                    pendingTimestamps[pk] = now();

                    function settle(){
                        blastsSettled++;
                        if (!resolved && blastsSettled >= blastsFired) delete acceptLocks[groupId];
                    }

                    if (_fetch){
                        var _ac = new AbortController();
                        blastControllers[blastIdx] = _ac; // register for sibling cancel
                        var _at = setTimeout(function(){ try { _ac.abort(); } catch(e){} }, 6000);
                        try {
                        _fetch(baseUrl + '?_=' + (now() + blastIdx * 37 + Math.floor(Math.random() * 99991)), {
                            method: 'GET',
                            signal: _ac.signal,
                            credentials: 'include',
                            redirect: 'follow',
                            keepalive: true,
                            priority: 'high',
                            headers: { 'Accept': 'text/html,*/*', 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache' }
                        }).then(function(resp){
                            clearTimeout(_at);
                            var fu = (resp.url || '').toLowerCase();
                            // FAST PATH: redirect URL = definitive accept — skip body read entirely
                            if (fu.indexOf('/tasks/') > -1 && fu.indexOf('accept_random') === -1){
                                pendingAccepts = Math.max(0, pendingAccepts - 1);
                                delete pendingTimestamps[pk];
                                if (!resolved){ resolved = true; cancelSiblingBlasts(); delete acceptLocks[groupId]; onAccepted(groupId, hitInfo, ''); }
                                settle(); return;
                            }
                            if (resp.status === 429 || resp.status === 503){
                                pendingAccepts = Math.max(0, pendingAccepts - 1);
                                delete pendingTimestamps[pk];
                                if (!resolved) onFail(resp.status, null);
                                settle(); return;
                            }
                            // 422 = not qualified / queue full — skip without reading body
                            if (resp.status === 422){
                                pendingAccepts = Math.max(0, pendingAccepts - 1);
                                delete pendingTimestamps[pk];
                                settle(); return;
                            }
                            return resp.text().then(function(text){
                                pendingAccepts = Math.max(0, pendingAccepts - 1);
                                delete pendingTimestamps[pk];
                                if (!resolved){
                                    if (captchaSystem.hasCaptchaInText(text)){
                                        resolved = true; delete acceptLocks[groupId]; captchaSystem.openTab();
                                    } else {
                                        onSucc(text, resp.url, resp.url);
                                    }
                                }
                                settle();
                            }).catch(function(){ // v25.0: handle body read failure
                                pendingAccepts = Math.max(0, pendingAccepts - 1);
                                delete pendingTimestamps[pk];
                                settle();
                            });
                        }).catch(function(e){
                            clearTimeout(_at);
                            pendingAccepts = Math.max(0, pendingAccepts - 1);
                            delete pendingTimestamps[pk];
                            settle();
                        });
                        } catch(e){
                            // _fetch() threw synchronously (e.g. context boundary error)
                            // Must clean up manually — .then/.catch never fires
                            clearTimeout(_at);
                            pendingAccepts = Math.max(0, pendingAccepts - 1);
                            delete pendingTimestamps[pk];
                            settle();
                        }
                    } else {
                        // GM_xmlhttpRequest path (used when fetch() is unavailable)
                        var _ar = {
                            method: 'GET',
                            url: baseUrl + '?_=' + (now() + blastIdx * 31 + Math.floor(Math.random() * 9973)),
                            headers: {
                                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                                'Cache-Control': 'no-cache, no-store, must-revalidate',
                                'Pragma': 'no-cache'
                            },
                            redirect: 'follow',
                            timeout: 6000,
                            onload: function(r){
                                pendingAccepts = Math.max(0, pendingAccepts - 1);
                                delete pendingTimestamps[pk];
                                if (resolved){ settle(); return; }
                                try {
                                    var fu = (r.finalUrl || r.responseURL || r.responseUrl || '').toLowerCase();
                                    if (fu.indexOf('/tasks/') > -1 && fu.indexOf('accept_random') === -1){
                                        // Definitive accept — call onAccepted directly, skip onSucc
                                        resolved = true; cancelSiblingBlasts(); delete acceptLocks[groupId]; onAccepted(groupId, hitInfo, '');
                                    } else if (r.status === 200){
                                        onSucc(r.responseText, r.finalUrl, r.responseURL || r.responseUrl || '');
                                    } else {
                                        onFail(r.status, r.responseText);
                                    }
                                } catch(e){}
                                settle();
                            },
                            onerror:   function(){ pendingAccepts = Math.max(0, pendingAccepts - 1); delete pendingTimestamps[pk]; settle(); },
                            ontimeout: function(){ pendingAccepts = Math.max(0, pendingAccepts - 1); delete pendingTimestamps[pk]; settle(); }
                        };
                        GM_xmlhttpRequest(_ar);
                    }
                })(b);
            }

            if (blastsFired === 0) delete acceptLocks[groupId];
        }

        function onAccepted(gid, hitInfo, assignId){
            runtime.acceptedCount++;
            // v25.4: bump per-gid counter so batch catcher can detect its own progress
            acceptCountByGid[gid] = (acceptCountByGid[gid] || 0) + 1;
            runtime.lastMinuteAccepts.push(now());
            var title = hitInfo ? (hitInfo.title || 'HIT') : 'HIT';
            var reward = hitInfo ? (hitInfo.reward || '0.00') : '0.00';
            var requester = hitInfo ? (hitInfo.requester || '') : '';
            var requesterId = hitInfo ? (hitInfo.requesterId || '') : '';
            var hitCount = hitInfo ? (parseInt(hitInfo.hitCount) || 0) : 0;
            var isBatch  = hitCount > 100;
            var isFav    = state.favoriteMode && state.favoriteHIT && state.favoriteHIT.groupId === gid;

            if (requesterId && requester) knownRequesters[requesterId] = requester;
            // v25.0: cap knownRequesters to prevent unbounded memory growth
            if (Object.keys(knownRequesters).length > 300){
                // v25.1: delete oldest 100 (insertion-order) — safe because recently-seen are at the end
                var _krKeys = Object.keys(knownRequesters);
                _krKeys.slice(0, 100).forEach(function(k){ delete knownRequesters[k]; });
            }
            state.acceptedHITs.unshift({
                id: gid, title: title, requester: requester, requesterId: requesterId,
                reward: reward, time: new Date().toLocaleTimeString(), verified: true
            });
            if (state.acceptedHITs.length > 80) state.acceptedHITs.pop();
            var st = title.length > 22 ? title.substring(0, 22) + '..' : title;
            log('★ CAUGHT ' + st + ' $' + reward + (requester ? ' — ' + requester.substring(0, 16) : ''), 'success');
            if (state.favoriteMode && state.favoriteHIT && state.favoriteHIT.groupId === gid){
                runtime.favAcceptCount++;
                updateFavoriteDisplay();
            }
            playRewardSound(reward);
            saveState();
            updateStatusDisplay(); // always instant — just numbers
            updateFavoriteDisplay(); // instant — relevant for fav tracking
            debouncedUpdateAccepted(); // debounced — prevents DOM thrash on batch accepts

            if (isFav || isBatch){
                // v25.0: 40ms gap (was 80ms) — just enough to prevent duplicate counting
                runtime.queueFree = Math.max(0, runtime.queueFree - 1);
                runtime.queueSize = Math.min(25, runtime.queueSize + 1);
                acceptedRecently[gid] = now();
                setTimeout(function(){ delete acceptedRecently[gid]; }, 40);
                // v25.0: sync every 3 fav accepts (was 5) — keep queueFree accurate
                if (runtime.favAcceptCount % 3 === 0) setTimeout(syncQueue, 100);
            } else if (hitCount > 1){
                // Multi-slot normal HIT — minimal cooldown so we grab the next slot FAST
                acceptedRecently[gid] = now();
                queuedGroupIds[gid] = true;
                runtime.queueFree = Math.max(0, runtime.queueFree - 1);
                runtime.queueSize = Math.min(25, runtime.queueSize + 1);
                setTimeout(function(){
                    delete acceptedRecently[gid];
                    delete queuedGroupIds[gid];  // unblock — grab next slot immediately
                }, 300);
            } else {
                // Single-slot HIT — queuedGroupIds is the permanent block.
                // acceptedRecently just prevents double-fire in the same scan burst.
                acceptedRecently[gid] = now();
                queuedGroupIds[gid] = true;
                queuedGroupTimestamps[gid] = hitInfo ? (hitInfo.lastUpdated || '') : '';
                runtime.queueFree = Math.max(0, runtime.queueFree - 1);
                runtime.queueSize = Math.min(25, runtime.queueSize + 1);
                setTimeout(function(){ delete acceptedRecently[gid]; }, 1500);
                // v25.3: clear after 8s (was 10s) — catch re-posts faster
                setTimeout(function(){ delete queuedGroupIds[gid]; delete queuedGroupTimestamps[gid]; }, 8000);
            }
        }

        // smartBlasts: module-scope — compiled ONCE, not recreated on every scan call
        //  1–3 slots  →  8 blasts   (max aggression — HIT gone in milliseconds)
        //  4–5        →  6 blasts
        //  6–20       → 10 blasts
        //  21–100     →  6 blasts
        //  101–999    → 12 blasts   (batch — fill queue fast)
        //  1000+      → 20 blasts   (mass batch)
        function smartBlasts(count){
            if (count <= 1)   return 25; // v25.0: single slot — MAXIMUM blast
            if (count <= 3)   return 20; // v25.0: 2-3 slots
            if (count <= 5)   return 15; // v25.0: 4-5 slots
            if (count <= 20)  return 12; // v25.0
            if (count <= 100) return 10; // v25.0
            if (count <= 999) return 18; // v25.0: batch — aggressive fill
            return 30;                    // v25.0: mass batch
        }

        // ================================================================
        //  PROCESS RESULTS
        function processResults(results){
            if (!results || !results.length || !runtime.isRunning || captchaSystem.captchaActive || isMegaGlobalOn()) return;

            // ── INSTANT FIRE: fire on results[0] with ZERO other work ──
            // This is the hot path. For page_size=1 scanners (5 of 10):
            // results.length=1, so after instant fire we return immediately.
            // No sort, no eligible loop, no extra allocations.
            var instantFiredGid = null;
            var newest = results[0];
            if (newest && newest.hit_set_id){
                var newestGid     = newest.hit_set_id;
                var newestReqId   = newest.requester_id  || '';
                var newestReqName = newest.requester_name || '';
                // Clear stale blocked entry for this gid if requester is not blocked
                // (requester may have re-posted same gid after it expired)
                if (blockedGroupIds[newestGid] && !isBlocked(newestReqId, newestReqName)){
                    delete blockedGroupIds[newestGid];
                }
                // Re-post detection: same GID with newer timestamp = requester re-posted
                if (queuedGroupIds[newestGid]) {
                    var _bts = queuedGroupTimestamps[newestGid] || '';
                    var _hts = newest.last_updated_time || newest.creation_time || '';
                    if (_hts && _bts && _hts !== _bts) { delete queuedGroupIds[newestGid]; delete queuedGroupTimestamps[newestGid]; } // v25.2: both must be non-empty & different — empty ts relies on 10s timeout
                }
                if (!blockedGroupIds[newestGid] && !isBlocked(newestReqId, newestReqName)){
                    var newestCount  = parseInt(newest.assignable_hits_count || newest.number_of_hits_available || 9999) || 9999;
                    var newestReward = parseFloat((newest.monetary_reward && newest.monetary_reward.amount_in_dollars) || 0);
                    var newestIsBatch = newestCount > 100;
                    // MINREWARD FILTER: instant-fire must respect the same reward filter as the
                    // eligible loop below. Without this, 5 of 10 page_size=1 scanners bypass
                    // minReward entirely because they return before the eligible loop runs.
                    if (state.minReward > 0 && newestReward < state.minReward){
                        if (results.length === 1) return; // single result — nothing else to do
                        // multi-result scan: fall through; eligible loop will also skip this HIT
                    } else {
                        var newestInfo = {
                            title: newest.title || 'HIT',
                            requester: newestReqName,
                            requesterId: newestReqId,
                            reward: String(newestReward),
                            groupId: newestGid,
                            hitCount: newestCount,
                            lastUpdated: newest.last_updated_time || newest.creation_time || ''
                        };
                        if (newestIsBatch) batchGroupIds[newestGid] = true;
                        fireAccept(newestGid, newestInfo, smartBlasts(newestCount));
                        instantFiredGid = newestGid;
                        if (results.length === 1) return; // fast exit for page_size=1 scanners
                    }
                } else {
                    // Never add the active favorite HIT to blockedGroupIds
                    var _isFavGid = state.favoriteMode && state.favoriteHIT && state.favoriteHIT.groupId === newestGid;
                    if (!_isFavGid) blockedGroupIds[newestGid] = true;
                    if (results.length === 1) return;
                }
            }

            // Fire favorite if visible in results
            if (state.favoriteMode && state.favoriteHIT && !isMegaGlobalOn()){
                var favFound = results.some(function(hit){ return hit.hit_set_id === state.favoriteHIT.groupId; });
                if (favFound) fireAccept(state.favoriteHIT.groupId, state.favoriteHIT, 25); // v25.0: 25 blasts
            }

            // Step 1: sort newest first (skip if 1 result — page_size=1 scanners)
            if (results.length > 1){
                results = results.slice().sort(function(a, b){
                    var ta = a.last_updated_time || a.creation_time || '';
                    var tb = b.last_updated_time || b.creation_time || '';
                    return ta > tb ? -1 : ta < tb ? 1 : 0;
                });
            }

            // Step 2: collect eligible HITs
            // Skip instantFiredGid — it was already fired above; firing again is a double-fire
            var eligible = [];
            results.forEach(function(hit){
                if (!runtime.isRunning || captchaSystem.captchaActive) return;
                var gid = hit.hit_set_id; if (!gid) return;
                if (gid === instantFiredGid) return; // already instant-fired — skip
                var reqId = hit.requester_id || '', reqName = hit.requester_name || '';
                if (reqId && reqName) knownRequesters[reqId] = reqName;
                if (isBlocked(reqId, reqName)){
                    if (gid) blockedGroupIds[gid] = true;
                    return;
                }
                var hitCount = parseInt(hit.assignable_hits_count || hit.number_of_hits_available || hit.hits_available || 9999) || 9999;
                // hitCount=0: MTurk count not yet propagated — try accept anyway (will 422 if truly gone)
                var isBatchHit = hitCount > 100 || !!batchGroupIds[gid];
                // No queueFull check — MTurk returns 422 if queue is truly full
                if (!isBatchHit) {
                    if (queuedGroupIds[gid]) {
                        var _bts2 = queuedGroupTimestamps[gid] || '';
                        var _hts2 = hit.last_updated_time || hit.creation_time || '';
                        if (_hts2 && _bts2 && _hts2 !== _bts2) { delete queuedGroupIds[gid]; delete queuedGroupTimestamps[gid]; } // v25.3
                        else { return; }
                    }
                    if (acceptedRecently[gid] || acceptLocks[gid]) return;
                }
                if (isBatchHit  && (acceptedRecently[gid] || acceptLocks[gid])) return;
                var info = { title: hit.title || 'HIT', requester: reqName, requesterId: reqId, reward: '0.00', groupId: gid, hitCount: hitCount, lastUpdated: hit.last_updated_time || hit.creation_time || '' };
                try {
                    var amt = hit.monetary_reward && hit.monetary_reward.amount_in_dollars;
                    if (amt !== undefined && amt !== null) info.reward = String(parseFloat(amt) || 0);
                } catch(e){}
                if (state.minReward > 0 && parseFloat(info.reward) < state.minReward) return;
                if (hitCount > 100){
                    batchGroupIds[gid] = true;
                    if (!groupTimers[gid]) startOneBatchCatcher(gid, info);
                }
                eligible.push({ gid: gid, info: info, hitCount: hitCount });
            });

            if (!eligible.length) return;


            // Fire all eligible HITs directly
            eligible.forEach(function(item){
                if (!runtime.isRunning || captchaSystem.captchaActive || isMegaGlobalOn()) return; // v24.8: MEGA mid-loop check
                fireAccept(item.gid, item.info, smartBlasts(item.hitCount));
            });
        }

        // ================================================================
        //  Dashboard HTML scanner removed in v16.3 (no requester info →
        //  bypassed blocklist). JSON scanners cover the same surface.
        // ================================================================

        // ================================================================
        //  DEDICATED SCANNER URLS — v16.6
        //
        //  12 scanners × 20ms delay — staggered: fast snipers 3ms apart, deep scanners 50ms apart
        //  Backoff 600ms/1200ms on 429 prevents cascade — scanners stay ALIVE
        //  continuously instead of constantly being 429'd and blinded.
        //
        //  Scanner 0: page_size=1,  unfiltered — fastest, detects newest HIT
        //  Scanners 0-7:  page_size=1, updated_desc — 8× ultra-fast new-HIT snipers
        //  Scanner  8:    page_size=1, num_hits_desc — batch sniffer
        //  Scanner  9:    page_size=10, unfiltered   — top-10 burst
        //  Scanner 10:    page_size=25, unfiltered   — full-25 sweep
        //  Scanner 11:    page_size=25, qualified    — qualified HITs
        //  Scanner 12:    page_size=25, page 2       — off-page-1 HITs
        //  Scanner 13:    page_size=25, page 3       — deep sweep
        // ================================================================
        var SCANNER_URLS = [];
        // sort=updated_desc is the correct MTurk param for newest HITs first
        var BASE = 'https://worker.mturk.com/projects.json?sort=updated_desc';

        function buildScannerUrls(){
            // minReward is applied CLIENT-SIDE in processResults — NOT in the URL.
            // MTurk's projects.json only supports filters[qualified] and filters[requester_id].
            // Adding filters[min_reward] to the URL causes MTurk to return empty results [],
            // which silently kills all HIT detection. Keep URLs clean.
            var p1u   = BASE + '&page_size=1';
            var p10u  = BASE + '&page_size=10';
            var p25u  = BASE + '&page_size=25';
            var p25q  = BASE + '&page_size=25&filters%5Bqualified%5D=true';
            var p25r  = BASE.replace('updated_desc','reward_desc') + '&page_size=25'; // high-$ full sweep in round-robin
            var pg2   = BASE + '&page_size=25&page_number=2';
            var pg3   = BASE + '&page_size=25&page_number=3';
            var pg4   = BASE + '&page_size=25&page_number=4';
            var p1b   = BASE.replace('updated_desc','num_hits_desc') + '&page_size=1'; // batch sniper

            SCANNER_URLS = [
                p1u,   // 0  — ultra-fast updated_desc (phase A, T+0ms)
                p1u,   // 1  — ultra-fast updated_desc (phase B, T+2ms)
                p1u,   // 2  — ultra-fast updated_desc (phase C, T+4ms)
                p1u,   // 3  — ultra-fast updated_desc (phase D, T+6ms)
                p1u,   // 4  — ultra-fast updated_desc (phase E, T+8ms)
                p1u,   // 5  — ultra-fast updated_desc (phase F, T+10ms)
                p1u,   // 6  — ultra-fast updated_desc (phase G, T+12ms)
                p1u,   // 7  — ultra-fast updated_desc (phase H, T+14ms)
                p1b,   // 8  — batch sniffer: sort=num_hits_desc, catches high-count HITs first
                p10u,  // 9  — top-10: catches burst of multiple new HITs
                p25u,  // 10 — full-25: batch detection + deeper sweep
                p25q,  // 11 — qualified: confirmed-eligible HITs
                pg2,   // 12 — page 2: HITs pushed off front page
                pg3    // 13 — page 3: deep sweep
                // pg4 and p25r join round-robin pool below
            ];

            // v24.9: extra round-robin entries — page 4 + reward sort full sweep
            // scanners 10-13 cycle through ALL entries from index 10 onward
            SCANNER_URLS.push(pg4);   // page 4 — catches HITs buried by large batches
            SCANNER_URLS.push(p25r);  // reward_desc full-25 — catches high-paying HITs that fall off updated_desc

            // Watched requesters — append dedicated scanner slot
            state.watchList.forEach(function(w){
                if (w.type === 'requester'){
                    var rid = encodeURIComponent(w.id);
                    SCANNER_URLS.push(p25u + '&filters%5Brequester_id%5D=' + rid);
                }
            });
        }

        // Legacy: rebuildUrlPatterns kept as no-op so old call sites don't break
        function rebuildUrlPatterns(){ buildScannerUrls(); }

        // Round-robin counter for scanner 6 — cycles through pg3 + all watch-list URLs
        var _watchRRIdx = 0;
        function getScannerUrl(scannerId){
            if (!SCANNER_URLS.length) buildScannerUrls();
            var idx;
            if (scannerId <= 9){
                // Scanners 0-9: fixed dedicated slots
                idx = Math.min(scannerId, SCANNER_URLS.length - 1);
            } else {
                // Scanner 10+: round-robin through all URLs from index 10 onward
                // This ensures pg3/pg4/reward_desc AND all watch-list requester URLs get scanned
                var extraCount = Math.max(1, SCANNER_URLS.length - 10);
                idx = 10 + (_watchRRIdx++ % extraCount);
                if (_watchRRIdx > 99999) _watchRRIdx = 0;
                idx = Math.min(idx, SCANNER_URLS.length - 1);
            }
            return SCANNER_URLS[idx] + '&_=' + now() + '&r=' + Math.floor(Math.random() * 99991);
        }

        // ================================================================
        // ================================================================
        //  SCANNERS
        //  BUG FIXES in v16.6:
        //  1. fetch() may be undefined in TM sandbox → safe reference with GM fallback
        //  2. fetch() has no timeout → AbortController + 5s setTimeout
        //  3. Global rateLimitUntil stopped ALL scanners on one 429 → per-scanner
        //     backoff. Only the scanner that got 429'd slows down. Others keep going.
        // ================================================================
        var fetchControllers = {};
        // Safe fetch reference — TM sandbox may expose fetch differently
        // ALWAYS use unsafeWindow.fetch — it runs in page context with the user's
        // mturk.com session cookies. TM's sandboxed fetch has no page cookies,
        // so accepts would 302 to login page instead of /tasks/. Scans also benefit
        // from auth cookies (qualified filter returns better results).
        var _fetch = (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.fetch === 'function' && unsafeWindow.fetch.bind(unsafeWindow)) ||
                     (typeof fetch === 'function' && fetch) ||
                     null;

        // Per-scanner rate limit (not global) — only the 429'd scanner backs off
        var scannerBackoff = {}; // scannerId → timestamp until which it should wait

        function isScannerBacked(id){ return now() < (scannerBackoff[id] || 0); }
        function recordScannerBackoff(id){
            var n = now();
            // v25.0: adaptive backoff — fast snipers (0-7) get shorter backoff
            var backoffMs = id <= 7 ? 600 : 1200; // v25.1: 600ms fast / 1200ms slow (was 150/300) — survive MTurk ban window
            scannerBackoff[id] = n + backoffMs; // global
            // Still record globally for auto-reload threshold check
            recordRateLimit();
        }

        function runScanner(id){
            if (!runtime.isRunning || captchaSystem.captchaActive) return;
            if (isScannerBacked(id)){
                scannerTimers[id] = setTimeout(function(){ runScanner(id); }, (scannerBackoff[id] || 0) - now() + 20);
                return;
            }
            lastScanTime = now();
            var t0 = now();
            runtime.scannedCount++;

            // Abort any previous in-flight scan for this slot
            if (fetchControllers[id]){ try { fetchControllers[id].abort(); } catch(e){} }

            // If fetch is not available, fall back to GM_xmlhttpRequest
            if (!_fetch){
                var _sr = {
                    method: 'GET',
                    url: getScannerUrl(id),
                    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                                'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' },
                    timeout: 2500,
                    onload: function(r){
                        runtime.scanSpeed = now() - t0;
                        // v25.4: capture body once — captcha pages can return any status
                        var _body = r.responseText || '';
                        // Captcha may arrive with any status code — check first.
                        if (captchaSystem.hasCaptchaInText(_body)){ captchaSystem.openTab(); return; }
                        if (r.status === 429 || r.status === 503){ recordScannerBackoff(id); scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 600); return; }
                        // v25.4: 422 = not qualified / queue full — NOT a rate-limit, do
                        // not record backoff. Aligns with the fetch path.
                        if (r.status === 422){ runtime.consecutiveErrors = 0; scannerTimers[id] = setTimeout(function(){ runScanner(id); }, state.scanDelay); return; }
                        if (_body.indexOf('Continue shopping') > -1){ recordScannerBackoff(id); scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 600); return; }
                        if (r.status !== 200){ runtime.consecutiveErrors++; scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 300); return; }
                        runtime.consecutiveErrors = 0;
                        try { processResults(JSON.parse(_body).results || []); } catch(e){}
                        scannerTimers[id] = setTimeout(function(){ runScanner(id); }, state.scanDelay);
                    },
                    onerror:   function(){ runtime.consecutiveErrors++; scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 400); },
                    ontimeout: function(){ runtime.consecutiveErrors++; scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 400); }
                };
                GM_xmlhttpRequest(_sr);
                return;
            }

            // fetch() path — faster, direct, no TM bridge overhead
            var ctrl = new AbortController();
            fetchControllers[id] = ctrl;

            // Timeout: abort fetch after 5 seconds if server hangs
            var fetchTimeout = setTimeout(function(){
                try { ctrl.abort(); } catch(e){}
            }, 2500);

            _fetch(getScannerUrl(id), {
                method: 'GET',
                signal: ctrl.signal,
                credentials: 'include',
                keepalive: true,
                priority: 'high',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache'
                }
            }).then(function(resp){
                clearTimeout(fetchTimeout);
                // v25.4: clear our controller slot — leaving stale aborts in
                // fetchControllers prevents stopScanners from cleaning up cleanly.
                if (fetchControllers[id] === ctrl) delete fetchControllers[id];
                runtime.scanSpeed = now() - t0;
                if (resp.status === 429 || resp.status === 503){
                    recordScannerBackoff(id);
                    scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 600);
                    return;
                }
                // v25.4: 422 = not qualified / queue full — reset consecutiveErrors
                // (it's a healthy scan, just nothing for us). Schedule normal next
                // scan, not the 300ms penalty box.
                if (resp.status === 422){ runtime.consecutiveErrors = 0; scannerTimers[id] = setTimeout(function(){ runScanner(id); }, state.scanDelay); return; }
                if (resp.status !== 200){
                    runtime.consecutiveErrors++;
                    scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 300);
                    return;
                }
                return resp.text().then(function(text){
                    if (!runtime.isRunning) return;
                    if (captchaSystem.hasCaptchaInText(text)){ captchaSystem.openTab(); return; }
                    if (text.indexOf('Continue shopping') > -1){ recordScannerBackoff(id); scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 600); return; }
                    runtime.consecutiveErrors = 0;
                    try { processResults(JSON.parse(text).results || []); } catch(e){ log('Scanner parse error: ' + e.message, 'warning'); }
                    scannerTimers[id] = setTimeout(function(){ runScanner(id); }, state.scanDelay);
                });
            }).catch(function(e){
                clearTimeout(fetchTimeout);
                if (fetchControllers[id] === ctrl) delete fetchControllers[id];
                if (e && e.name === 'AbortError'){
                    // Aborted by timeout (5s) or by stopScanners — reschedule only if still running
                    if (runtime.isRunning && !captchaSystem.captchaActive){
                        runtime.consecutiveErrors++;
                        scannerTimers[id] = setTimeout(function(){ runScanner(id); }, 300);
                    }
                    return;
                }
                runtime.consecutiveErrors++;
                scannerTimers[id] = setTimeout(function(){ runScanner(id); }, runtime.consecutiveErrors > 8 ? 2000 : 300);
            });
        }

        function startScanners(){
            stopScanners();
            buildScannerUrls();
            var n = Math.max(1, Math.min(20, state.parallelScanners));
            scannerTimers = new Array(n).fill(null);
            for (var i = 0; i < n; i++){
                (function(id){
                    // v25.0: smart stagger — fast snipers (0-7) at 3ms, slow scanners at 50ms
                    var delay = id <= 7 ? id * 3 : 24 + (id - 8) * 50;
                    setTimeout(function(){ runScanner(id); }, delay);
                })(i);
            }
        }
        function stopScanners(){
            scannerTimers.forEach(function(t, i){ if (t !== null){ clearTimeout(t); scannerTimers[i] = null; } });
            scannerTimers = [];
            Object.keys(fetchControllers).forEach(function(id){ try { fetchControllers[id].abort(); } catch(e){} });
            fetchControllers = {};
        }

        // ================================================================
        //  GROUP CATCHERS / FAVORITE / WARM / WATCHDOG
        // ================================================================
        function startGroupCatchers(){ stopGroupCatchers(); state.watchList.forEach(function(w){ if (w.type === 'group') startOneGroup(w.id); }); }
        function startOneGroup(gid){
            if (groupTimers[gid]) return;
            // v25.4: pass a stub hitInfo with hitCount=999 so onAccepted treats this
            // like a multi-slot HIT (300ms cooldown) instead of single-slot (8s).
            // Watched groups are explicitly user-curated — they should re-fire fast.
            var stubInfo = { title: 'Watched ' + gid.substring(0,10), hitCount: 999, groupId: gid };
            groupTimers[gid] = setInterval(function(){
                if (runtime.isRunning && !captchaSystem.captchaActive && !isMegaGlobalOn() && !queuedGroupIds[gid])
                    fireAccept(gid, stubInfo, 10);
            }, 100); // 100ms fixed — independent of favorite focus speed
        }
        // Dedicated tight-loop for auto-detected batch HITs (>100 slots)
        // 6 blasts every 150ms — fills 25-slot queue in ~3-4 seconds
        function startOneBatchCatcher(gid, hitInfo){
            if (groupTimers[gid]) return;
            log('■ BATCH — auto-loop: ' + (hitInfo && hitInfo.title ? hitInfo.title.substring(0,24) : gid), 'warning');
            var _batchFails = 0, _batchLastAccept = now(); // termination counters
            // v25.4: track THIS batch's accept count (not the global counter), so
            // unrelated accepts on other scanners can't trick us into thinking the
            // batch is still producing.
            acceptCountByGid[gid] = acceptCountByGid[gid] || 0;
            groupTimers[gid] = setInterval(function(){
                if (!runtime.isRunning || captchaSystem.captchaActive || isMegaGlobalOn()){ return; }
                if (!batchGroupIds[gid]){ clearInterval(groupTimers[gid]); delete groupTimers[gid]; delete acceptCountByGid[gid]; return; }
                // Stop after 60s with no accepts FOR THIS gid, or 200 consecutive non-accepts
                if (now() - _batchLastAccept > 60000 || _batchFails > 200){
                    log('Batch loop ended: ' + (hitInfo && hitInfo.title ? hitInfo.title.substring(0,20) : gid), 'info');
                    delete batchGroupIds[gid]; clearInterval(groupTimers[gid]); delete groupTimers[gid]; delete acceptCountByGid[gid]; return;
                }
                // v25.4: snapshot THIS gid's count, fire, check after settle delay
                (function(){
                    var _snap = acceptCountByGid[gid] || 0;
                    fireAccept(gid, hitInfo, 8);
                    setTimeout(function(){
                        if ((acceptCountByGid[gid] || 0) === _snap) _batchFails++;
                        else { _batchFails = 0; _batchLastAccept = now(); }
                    }, 600);
                })();
            }, 120);
        }
        function stopGroupCatchers(){ Object.keys(groupTimers).forEach(function(g){ clearInterval(groupTimers[g]); }); groupTimers = {}; }

        function setFavorite(h){
            state.favoriteHIT = { groupId: h.id || h.groupId, title: h.title || 'HIT', requester: h.requester || '', requesterId: h.requesterId || '', reward: h.reward || '' };
            state.favoriteMode = true; runtime.favAcceptCount = 0; runtime.favAttemptCount = 0;
            saveState(); updateFavoriteDisplay(); updateAcceptedDisplay(); startFavoriteCatcher();
            log('FOCUS: ' + (h.title || h.id).substring(0, 25), 'success');
        }
        function clearFavorite(){
            state.favoriteMode = false; state.favoriteHIT = null; runtime.favAcceptCount = 0; runtime.favAttemptCount = 0;
            stopFavoriteCatcher(); saveState(); updateFavoriteDisplay(); updateAcceptedDisplay();
            log('Favorite cleared', 'info');
        }
        function startFavoriteCatcher(){
            stopFavoriteCatcher();
            if (!state.favoriteMode || !state.favoriteHIT) return;
            var _favSyncPending = false; // v25.0: guard against syncQueue spam
            favoriteTimer = setInterval(function(){
                if (!captchaSystem.captchaActive && runtime.isRunning && !isMegaGlobalOn()){
                    // v25.0 FIX: queue full — one sync at a time with 2s cooldown
                    if (runtime.queueFree <= 0){
                        if (!_favSyncPending && !syncRunning && (now() - lastQueueSync > 2000)){
                            _favSyncPending = true;
                            syncQueue(function(){ _favSyncPending = false; });
                        }
                        return;
                    }
                    runtime.favAttemptCount++; updateFavoriteDisplay();
                    fireAccept(state.favoriteHIT.groupId, state.favoriteHIT, 20); // v25.0: 20 blasts
                }
            }, state.favoriteFocusInterval);
        }
        function stopFavoriteCatcher(){ if (favoriteTimer){ clearInterval(favoriteTimer); favoriteTimer = null; } }

        function startWarm(){
            if (!state.connectionWarm) return;
            if (warmTimer) clearInterval(warmTimer);
            warmTimer = setInterval(function(){
                if (!runtime.isRunning || isRateLimited()) return;
                var warmUrl = 'https://worker.mturk.com/projects.json?page_size=1&_=' + now();
                if (_fetch){
                    _fetch(warmUrl, { method: 'HEAD', credentials: 'include', keepalive: true })
                        .then(function(){}).catch(function(){});
                } else {
                    GM_xmlhttpRequest({ method: 'HEAD', url: warmUrl, headers: { 'Accept': 'application/json' }, timeout: 4000, onload: function(){}, onerror: function(){} });
                }
            }, 10000); // v25.0: 10s warm (was 15s)
        }
        function stopWarm(){ if (warmTimer){ clearInterval(warmTimer); warmTimer = null; } }

        // ================================================================
        //  SESSION REFRESH — every 60s, silently re-fetches projects.json
        //  to keep the MTurk session alive WITHOUT reloading the page.
        //  No auto-start trigger. Script keeps running with zero interruption.
        // ================================================================
        function startReloadTimer(){
            stopReloadTimer();
            reloadCountdown = 60;
            updateReloadDisplay();
            reloadTimer = setInterval(function(){
                reloadCountdown--;
                updateReloadDisplay();
                if (reloadCountdown <= 0){
                    reloadCountdown = 60;   // reset immediately — keep counting
                    updateReloadDisplay();
                    // Silent background ping — keeps MTurk session alive, no page reload
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: 'https://worker.mturk.com/projects.json?page_size=1&sort=updated_desc&_=' + now(),
                        headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache' },
                        timeout: 8000,
                        onload: function(){},
                        onerror: function(){ log('Session refresh failed', 'warning'); }
                    });
                }
            }, 1000);
        }
        function stopReloadTimer(){
            if (reloadTimer){ clearInterval(reloadTimer); reloadTimer = null; }
            reloadCountdown = 60;
            updateReloadDisplay();
        }
        function updateReloadDisplay(){
            var el = gel('mrp-reload-cd');
            if (!el) return;
            if (!reloadTimer){ el.textContent = '—'; el.style.color = '#888'; return; }
            el.textContent = reloadCountdown + 's';
            el.style.color = reloadCountdown <= 10 ? '#e74c3c' : reloadCountdown <= 20 ? '#f39c12' : '#2ecc71';
        }

        // ================================================================
        //  WATCHDOG — health-checks all async state every 4s
        // ================================================================
        function startWatchdog(){
            stopWatchdog();
            watchdogTimer = setInterval(function(){
                // ── MEGA GLOBAL POLL ──
                // Every tab checks the shared key every 2s.
                // If MEGA was turned ON by any other tab, stop this tab immediately.
                if (isMegaGlobalOn()){
                    if (runtime.isRunning){
                        log('⛔ MEGA signal received — stopping this account', 'warning');
                        _megaWasRunning = true; // v24.8: was running, MEGA stopped it
                        stopScan(false);
                    }
                    state.megaActive = true;
                    updateMegaBtn();
                    return; // don't run other watchdog checks while MEGA is on
                }
                // If MEGA was just turned OFF, sync local state
                if (state.megaActive && !isMegaGlobalOn()){
                    state.megaActive = false;
                    updateMegaBtn();
                }

                // ── GLOBAL START/STOP POLL ──
                // Any tab can signal all others to start or stop.
                var globalRun = getGlobalRun();
                if (globalRun === '1' && !runtime.isRunning && !captchaSystem.captchaActive){
                    log('▶ Global START signal — starting', 'success');
                    startScan();
                } else if (globalRun === '0' && runtime.isRunning){
                    log('■ Global STOP signal — stopping', 'warning');
                    // Use force=true so wasRunning is preserved for later resume
                    stopScan(true);
                }

                if (!runtime.isRunning || captchaSystem.captchaActive) return;
                var n = now();

                // Clear blockedGroupIds cache every 90s — prevents stale entries
                if (n - blockedGroupIdsAge > 90000){
                    blockedGroupIds = {};
                    blockedGroupIdsAge = n;
                }

                // Scanner stall detection — 5s without a scan means dead scanner
                if (lastScanTime > 0 && n - lastScanTime > 3000){ // v25.0: 3s stall threshold (was 5s)
                    log('Watchdog: scanner stall — restarting', 'warning');
                    startScanners(); lastScanTime = n;
                }

                // Clean up stale pending accepts (10s timeout) — HARD SYNC counter to actual entries
                if (pendingAccepts > 0 || Object.keys(pendingTimestamps).length > 0){
                    Object.keys(pendingTimestamps).forEach(function(k){
                        if (n - pendingTimestamps[k] >= 10000){ delete pendingTimestamps[k]; }
                    });
                    // v25.0 FIX: hard-sync pendingAccepts to actual size — prevents permanent drift
                    var actualPending = Object.keys(pendingTimestamps).length;
                    if (pendingAccepts !== actualPending){ pendingAccepts = actualPending; }
                }

                // Clear stale acceptLocks — stuck locks permanently block HIT re-accepts
                // A lock is stale if it has no corresponding pendingTimestamp AND has been held >5s
                var lockKeys = Object.keys(acceptLocks);
                if (lockKeys.length > 0){
                    lockKeys.forEach(function(g){
                        // If nothing is in-flight for this group, the lock is stuck — clear it
                        var hasInFlight = Object.keys(pendingTimestamps).some(function(k){ return k.indexOf(g + '_') === 0; });
                        if (!hasInFlight){
                            delete acceptLocks[g];
                        } else {
                            // v25.0: even with in-flight, clear lock if held > 8s (stuck blast)
                            var _oldestFlight = Infinity;
                            Object.keys(pendingTimestamps).forEach(function(k){
                                if (k.indexOf(g + '_') === 0) _oldestFlight = Math.min(_oldestFlight, pendingTimestamps[k]);
                            });
                            if (n - _oldestFlight > 8000) delete acceptLocks[g];
                        }
                    });
                }

                // v25.4: clear stale acceptedRecently — 2000ms threshold so the
                // watchdog never preempts the longest setTimeout (1500ms single-slot).
                // Each onAccepted path has its own setTimeout doing the precise removal;
                // this is just a safety net for entries that leak (e.g. interrupted closures).
                Object.keys(acceptedRecently).forEach(function(k){
                    if (n - acceptedRecently[k] > 2000) delete acceptedRecently[k];
                });

                // Queue sync every 8s — moved here from scanner to keep scanner tight
                if (n - lastQueueSync > 8000) syncQueue();

                // v25.1: prune stale batchGroupIds every 5 minutes — timestamp-based (was fragile modulo)
                if (!_lastBatchPrune) _lastBatchPrune = n;
                if (n - _lastBatchPrune > 300000){
                    _lastBatchPrune = n;
                    var _bgKeys = Object.keys(batchGroupIds);
                    if (_bgKeys.length > 20){
                        _bgKeys.slice(0, _bgKeys.length - 10).forEach(function(gid){
                            delete batchGroupIds[gid];
                            if (groupTimers[gid]){ clearInterval(groupTimers[gid]); delete groupTimers[gid]; }
                        });
                    }
                }

                // Cross-page panel visibility sync — reads fast GM key written by tab toggle
                try {
                    var _pv = GM_getValue('mrp_panel_vis', '');
                    if (_pv !== '') {
                        var _wantVis = _pv === '1';
                        if (_wantVis !== state.panelVisible) {
                            state.panelVisible = _wantVis;
                            var _pp = gel('mrp-panel'); var _pt = gel('mrp-tab');
                            if (_pp) _pp.style.display = _wantVis ? '' : 'none';
                            if (_pt) _pt.style.right = _wantVis ? '460px' : '0';
                        }
                    }
                } catch(e){}

            }, 2000); // check every 2s for faster response to issues
        }
        function stopWatchdog(){ if (watchdogTimer){ clearInterval(watchdogTimer); watchdogTimer = null; } }

        // ================================================================
        //  GLOBAL POLLER — runs always, even when IDLE
        //  Polls cross-browser sync API every 3 seconds.
        //  Also checks local GM key for same-browser tabs (instant).
        //  ONLY starts after detectTeam() has locked in _teamKey.
        //  Each team's signals are 100% isolated — key = team name.
        // ================================================================
        var _pollerStarted = false; // guard against double-start
        function startGlobalPoller(){
            // Safety: never run if team key is not resolved
            if (!_teamKey || _teamKey === 'DEFAULT') {
                log('Poller blocked — team not detected yet', 'warning');
                return;
            }
            // Guard: only ever start once — stacked pollers would double-fire signals
            if (_pollerStarted) { log('Poller already running — skipping duplicate start', 'warning'); return; }
            _pollerStarted = true;
            log('Poller started for team: ' + _teamKey, 'info');

            // Same-browser fast poll — every 2s via GM_getValue (instant, no network)
            // Uses team-scoped GM key so different teams on same browser don't clash
            var gmKey = 'mrp_run_' + _teamKey;
            setInterval(function(){
                if (isMegaGlobalOn()) return;
                var localRun = '';
                try { localRun = GM_getValue(gmKey, ''); } catch(e){}
                if (localRun === '1' && !runtime.isRunning && !captchaSystem.captchaActive){
                    startScan();
                } else if (localRun === '0' && runtime.isRunning){
                    stopScan(true);
                }
            }, 2000);

            // Cross-browser poll — every 3s via API
            if (!SYNC_API_URL) return;
            setInterval(function(){
                readSyncSignal(function(signal){
                    if (!signal || signal === lastSyncSignal[_teamKey]) return;
                    lastSyncSignal[_teamKey] = signal;

                    if (signal === 'RUN'){
                        try { GM_setValue(gmKey, '1'); } catch(e){}
                        if (!runtime.isRunning && !captchaSystem.captchaActive && !isMegaGlobalOn()){
                            log('▶ START signal received — team: ' + _teamKey, 'success');
                            startScan();
                        }
                    } else if (signal === 'STOP'){
                        try { GM_setValue(gmKey, '0'); } catch(e){}
                        if (runtime.isRunning){
                            log('■ STOP signal received — team: ' + _teamKey, 'warning');
                            stopScan(true);
                        }
                    } else if (signal === 'MEGA_ON'){
                        // MEGA activated from another browser — stop this tab immediately
                        try { GM_setValue(MEGA_GLOBAL_KEY, '1'); } catch(e){}
                        if (runtime.isRunning){
                            log('⛔ MEGA ON received (cross-browser) — stopping', 'warning');
                            _megaWasRunning = true; // v24.8: was running before cross-browser MEGA
                            stopScan(false);
                        }
                        state.megaActive = true;
                        updateMegaBtn();
                    } else if (signal === 'MEGA_OFF'){
                        // MEGA deactivated from another browser — allow resume
                        try { GM_setValue(MEGA_GLOBAL_KEY, '0'); } catch(e){}
                        state.megaActive = false;
                        log('✅ MEGA OFF received (cross-browser) — accounts active', 'success');
                        updateMegaBtn();
                        // v24.8: only resume if this tab was running when MEGA activated
                        if (_megaWasRunning && !runtime.isRunning && !captchaSystem.captchaActive){
                            _megaWasRunning = false;
                            startScan();
                        } else {
                            _megaWasRunning = false;
                        }
                    }
                });
            }, 3000);

            // Start min reward poller — already started by initTeamAndPoller
        }

        // ================================================================
        //  START / STOP
        // ================================================================
        function startScan(){
            if (runtime.isRunning) return;
            if (isMegaGlobalOn()){ log('⛔ MEGA is active — press MEGA to unlock first', 'warning'); updateMegaBtn(); return; }
            setGlobalRun(true);  // signal all other tabs to start
            captchaSystem.captchaActive = false;
            captchaSystem.stopRepeating(); captchaSystem.stopResumeWatch();
            captchaSystem.removeOverlay(); captchaSystem.clearMark();
            // Don't read panel inputs — state already has correct forced values from loadState
            runtime.isRunning = true; runtime.startTime = now();
            runtime.acceptedCount = 0; runtime.scannedCount = 0; runtime.attemptCount = 0;
            runtime.serverBusyCount = 0; runtime.consecutiveErrors = 0;
            runtime.lastMinuteAccepts = []; runtime.favAcceptCount = 0; runtime.favAttemptCount = 0;
            runtime.queueSize = 0; runtime.queueFree = 25;
            rateLimitUntil = 0; rateLimitHistory = [];
            scannerBackoff = {};
            acceptedRecently = {}; acceptLocks = {}; queuedGroupIds = {}; queuedGroupTimestamps = {}; blockedGroupIds = {};
            // Clear batchGroupIds and stop any running batch catcher loops
            Object.keys(batchGroupIds).forEach(function(gid){ if (groupTimers[gid]){ clearInterval(groupTimers[gid]); delete groupTimers[gid]; } });
            batchGroupIds = {};
            acceptCountByGid = {}; // v25.4: reset per-gid accept counter on (re)start
            pendingAccepts = 0; pendingTimestamps = {};
            lastScanTime = now(); syncRunning = false;
            try { GM_setValue(WAS_RUNNING, '0'); } catch(e){}
            log(TOOL_NAME + ' v' + VERSION + ' STARTED — ' + state.parallelScanners + ' scanners, instant-fire mode', 'success');
            if (state.minReward > 0){
                log('⚠ Min $ filter: $' + state.minReward.toFixed(2) + ' — HITs below this are skipped. Set to 0.00 for batch HITs like $0.02', 'warning');
            }
            rebuildUrlPatterns();
            // START SCANNERS IMMEDIATELY — do not wait for syncQueue.
            // syncQueue is a network call (1-8s). Any HIT posted during that wait is missed.
            // Queue state (queueFree) starts at 25 — correct default. syncQueue will sync in background.
            startScanners();
            startWarm();
            startGroupCatchers();
            if (state.favoriteMode && state.favoriteHIT) startFavoriteCatcher();
            if (state.captchaProbeEnabled){
                captchaSystem.probeInterval = state.captchaProbeMinutes * 60000;
                captchaSystem.startProbe();
            }
            startWatchdog();
            startReloadTimer();
            // Queue sync runs in parallel — updates queueFree/queueSize without blocking scanners
            syncQueue();
            uptimeTimer = setInterval(updateStatusDisplay, 400);
            saveNow(); updateToggleBtn(); updateStatusDisplay();
        }

        function stopScan(force){
            // force=true means auto-stop (captcha/lock) — preserve wasRunning for auto-resume
            // force=false/undefined means user manually stopped — don't auto-restart on reload
            try { GM_setValue(WAS_RUNNING, (force && runtime.isRunning) ? '1' : '0'); } catch(e){}
            state.wasRunning = !!(force && runtime.isRunning);
            if (!force) setGlobalRun(false);  // signal all other tabs to stop (user-initiated only)
            runtime.isRunning = false; runtime.startTime = null;
            stopAllTimers();
            stopReloadTimer();
            log('STOPPED', 'warning');
            saveNow(); updateToggleBtn(); updateStatusDisplay();
        }

        // ================================================================
        //  MEGA — Master kill switch controlled by admin Google Sheet
        //  Writes to GM_setValue shared key → ALL tabs read it and stop.
        //  ON  → stops ALL scanning and accepting on every open tab
        //  OFF → allows all tabs to resume
        // ================================================================
        function toggleMega(){
            var btn = gel('mrp-mega-btn');
            var msg = gel('mrp-mega-msg');
            if (btn){ btn.disabled = true; btn.textContent = 'MEGA...'; }
            if (msg){ msg.textContent = 'Reading sheet...'; msg.style.color = '#f39c12'; }

            var currentlyOn = isMegaGlobalOn();

            // Read sheet for live count then toggle
            GM_xmlhttpRequest({
                method: 'GET',
                url: MEGA_SHEET_URL + '&nocache=' + now(),
                headers: { 'Cache-Control': 'no-cache, no-store', 'Accept': 'text/csv,text/plain,*/*' },
                timeout: 15000,
                onload: function(r){
                    var count = 0;
                    if (r.status === 200 && r.responseText && r.responseText.indexOf('<html') === -1){
                        var workerRx = /A[A-Z0-9]{5,19}/g;
                        var matches = r.responseText.match(workerRx);
                        count = matches ? matches.length : 0;
                    }
                    applyMegaToggle(!currentlyOn, count);
                    if (btn) btn.disabled = false;
                },
                onerror: function(){
                    applyMegaToggle(!currentlyOn, 0);
                    if (btn) btn.disabled = false;
                },
                ontimeout: function(){
                    if (btn){ btn.disabled = false; }
                    if (msg){ msg.textContent = '✗ Sheet timeout — try again'; msg.style.color = '#e74c3c'; }
                    setTimeout(function(){ if (msg) msg.textContent = ''; }, 5000);
                    updateMegaBtn();
                }
            });
        }

        function applyMegaToggle(turnOn, count){
            var msg = gel('mrp-mega-msg');
            var countTxt = count > 0 ? ' · ' + count + ' IDs in sheet' : '';

            if (turnOn){
                // ── MEGA ON ── write global flag → this tab AND all others stop
                setMegaGlobal(true);
                state.megaActive = true;
                // v24.8: save running state BEFORE stopScan zeroes it
                _megaWasRunning = runtime.isRunning;
                // Stop THIS tab immediately
                if (runtime.isRunning) stopScan(false);
                if (msg){ msg.textContent = '⛔ MEGA ON — all accounts stopped' + countTxt; msg.style.color = '#e74c3c'; }
                log('⛔ MEGA ON — all accounts stopped' + countTxt, 'warning');
            } else {
                // ── MEGA OFF ── clear global flag → all tabs can resume
                setMegaGlobal(false);
                state.megaActive = false;
                if (msg){ msg.textContent = '✅ MEGA OFF — all accounts active' + countTxt; msg.style.color = '#2ecc71'; }
                log('✅ MEGA OFF — all accounts active' + countTxt, 'success');
                // v24.8: only resume if scan was actually running when MEGA was activated
                // (not just because autoStartEnabled=true — that would restart manually-stopped accounts)
                if (_megaWasRunning){
                    _megaWasRunning = false;
                    startScan();
                } else {
                    _megaWasRunning = false;
                }
            }

            updateMegaBtn();
            saveState();
            setTimeout(function(){ if (msg) msg.textContent = ''; }, 6000);
        }

        function updateMegaBtn(){
            var btn = gel('mrp-mega-btn');
            if (!btn) return;
            var on = isMegaGlobalOn();
            if (on){
                btn.textContent = '⛔ MEGA: ON — Click to Resume';
                btn.style.background = '#e74c3c';
                btn.style.boxShadow = '0 0 12px rgba(231,76,60,.6)';
                btn.style.animation = 'megaPulse 1.5s infinite';
            } else {
                btn.textContent = '⚡ MEGA';
                btn.style.background = '#8e44ad';
                btn.style.boxShadow = '';
                btn.style.animation = '';
            }
        }

        // ================================================================
        //  RETURN ALL HITs
        // ================================================================
        function returnAllHITs(){
            var btn = gel('mrp-return-btn');
            if (btn){ btn.textContent = 'Returning...'; btn.disabled = true; }
            log('Returning all HITs...', 'warning');
            GM_xmlhttpRequest({
                method: 'GET', url: 'https://worker.mturk.com/tasks', headers: { 'Accept': 'text/html' }, timeout: 15000,
                onload: function(r){
                    if (r.status === 429 || r.status === 503){ if (btn){ btn.textContent = 'RETURN ALL'; btn.disabled = false; } return; }
                    var html = r.responseText || '', csrf = '';
                    var cm = html.match(/name="csrf_token"\s+content="([^"]+)"/i); if (cm) csrf = cm[1];
                    if (!csrf){ cm = html.match(/authenticity_token['"]\s*(?:value|content)=['"]([\w+\/=\-]+)['"]/i); if (cm) csrf = cm[1]; }
                    if (!csrf){ log('RETURN ALL: no CSRF token found', 'warning'); if (btn){ btn.textContent = 'RETURN ALL'; btn.disabled = false; } return; }
                    var ids = [], rx = /action="\/tasks\/([^"]+?)\/return"/gi, fm;
                    while ((fm = rx.exec(html))) if (ids.indexOf(fm[1]) === -1) ids.push(fm[1]);
                    if (!ids.length){ log('Queue empty', 'info'); if (btn){ btn.textContent = 'RETURN ALL'; btn.disabled = false; } return; }
                    var ok = 0, fail = 0, total = ids.length;
                    ids.forEach(function(id, i){
                        setTimeout(function(){
                            GM_xmlhttpRequest({
                                method: 'POST', url: 'https://worker.mturk.com/tasks/' + id + '/return',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf },
                                data: 'authenticity_token=' + encodeURIComponent(csrf) + '&_method=post',
                                timeout: 10000,
                                onload: function(r2){
                                    if (r2.status >= 200 && r2.status < 400) ok++; else fail++;
                                    if (ok + fail >= total){
                                        log('Returned ' + ok, ok > 0 ? 'success' : 'warning');
                                        if (btn){ btn.textContent = 'Done: ' + ok; btn.disabled = false; setTimeout(function(){ btn.textContent = 'RETURN ALL'; }, 2000); }
                                        syncQueue();
                                    }
                                },
                                onerror: function(){ fail++; if (ok + fail >= total && btn){ btn.textContent = 'RETURN ALL'; btn.disabled = false; } }
                            });
                        }, i * 300);
                    });
                },
                onerror: function(){ if (btn){ btn.textContent = 'RETURN ALL'; btn.disabled = false; } }
            });
        }

        // ================================================================
        //  THEME
        // ================================================================
        function applyTheme(){ var p = gel('mrp-panel'), t = gel('mrp-tab'); if (!p) return; p.className = state.darkMode ? 'mrp-dark' : 'mrp-light'; if (t) t.className = state.darkMode ? 'mrp-tab-d' : 'mrp-tab-l'; }
        function toggleTheme(){ state.darkMode = !state.darkMode; applyTheme(); saveState(); var b = gel('mrp-theme-btn'); if (b) b.textContent = state.darkMode ? 'Dark' : 'Light'; }

        // ================================================================
        //  UI UPDATES
        // ================================================================
        function updateAll(){ updateStatusDisplay(); updateAcceptedDisplay(); updateFavoriteDisplay(); }

        // Debounced accepted list update — max once per 400ms during fast batch accepts
        // Prevents 5+ full DOM rebuilds/second which causes visible lag
        var _acceptedDebounce = null;
        function debouncedUpdateAccepted(){
            if (_acceptedDebounce) clearTimeout(_acceptedDebounce);
            _acceptedDebounce = setTimeout(function(){ _acceptedDebounce = null; updateAcceptedDisplay(); }, 400);
        }

        function updateStatusDisplay(){
            var el;
            el = gel('mrp-status-text');
            if (el){
                if (captchaSystem.captchaActive){ el.textContent = 'CAPTCHA'; el.className = 'mrp-sv sv-err'; }
                else if (state.favoriteMode && runtime.isRunning){ el.textContent = 'FOCUS'; el.className = 'mrp-sv sv-fav'; }
                else if (runtime.isRunning){ el.textContent = 'RUNNING'; el.className = 'mrp-sv sv-on'; }
                else { el.textContent = 'IDLE'; el.className = 'mrp-sv sv-off'; }
            }
            el = gel('mrp-accepted-count'); if (el) el.textContent = runtime.acceptedCount;
            el = gel('mrp-scanned-count'); if (el) el.textContent = runtime.scannedCount;
            el = gel('mrp-attempt-count'); if (el) el.textContent = runtime.attemptCount;
            el = gel('mrp-uptime'); if (el) el.textContent = getUptime();
            el = gel('mrp-hpm'); if (el) el.textContent = getHPM();
            el = gel('mrp-speed'); if (el) el.textContent = runtime.scanSpeed ? runtime.scanSpeed + 'ms' : '—';
            el = gel('mrp-pending'); if (el) el.textContent = pendingAccepts;
            el = gel('mrp-queue-size'); if (el) el.textContent = runtime.queueSize + '/25';
            el = gel('mrp-queue-free'); if (el) el.textContent = runtime.queueFree;
            el = gel('mrp-busy-count');
            if (el){
                el.textContent = runtime.serverBusyCount;
                el.style.color = runtime.serverBusyCount >= 80 ? '#e74c3c' : runtime.serverBusyCount >= 50 ? '#f39c12' : '';
            }
        }

        function updateToggleBtn(){ var b = gel('mrp-toggle-btn'); if (!b) return; b.textContent = runtime.isRunning ? 'STOP' : 'START'; b.className = runtime.isRunning ? 'mb mb-stop' : 'mb mb-start'; }

        function updateFavoriteDisplay(){
            var el = gel('mrp-fav-display'); if (!el) return;
            if (!state.favoriteMode || !state.favoriteHIT){ el.innerHTML = '<div class="mrp-empty">Click ★ on a caught HIT to focus</div>'; return; }
            var f = state.favoriteHIT, t = f.title || f.groupId || 'HIT';
            if (t.length > 28) t = t.substring(0, 28) + '..';
            el.innerHTML = '<div class="fav-box"><div class="fav-top"><b class="fav-t">' + esc(t) + '</b>' + (f.reward ? '<span class="fav-r">$' + esc(f.reward) + '</span>' : '') + '</div>' + (f.requester ? '<div class="fav-req">' + esc(f.requester) + '</div>' : '') + '<div class="fav-stats">Try: <b>' + runtime.favAttemptCount + '</b> | Got: <b class="fav-got">' + runtime.favAcceptCount + '</b></div><button class="mb mb-clear" id="mrp-cfav-inner">Clear</button></div>';
            var c = gel('mrp-cfav-inner'); if (c) c.onclick = function(ev){ ev.stopPropagation(); clearFavorite(); };
        }

        function updateAcceptedDisplay(){
            var el = gel('mrp-accepted-list'); if (!el) return;
            if (!state.acceptedHITs.length){ el.innerHTML = '<div class="mrp-empty">No HITs caught yet</div>'; return; }
            var html = '', n = Math.min(state.acceptedHITs.length, 20);
            for (var i = 0; i < n; i++){
                var h = state.acceptedHITs[i], t = h.title || 'HIT';
                if (t.length > 20) t = t.substring(0, 20) + '..';
                var req = h.requester || ''; if (req.length > 12) req = req.substring(0, 12) + '..';
                var isFav = state.favoriteMode && state.favoriteHIT && state.favoriteHIT.groupId === h.id;
                html += '<div class="hit-row' + (isFav ? ' hit-fav' : '') + '">' +
                    '<span class="hit-ck">' + (h.verified ? '✓' : '?') + '</span>' +
                    '<span class="hit-tt">' + esc(t) + '</span>';
                if (h.reward) html += '<span class="hit-rw">$' + esc(h.reward) + '</span>';
                if (h.id && !isFav) html += '<button class="hit-star" data-idx="' + i + '">★</button>';
                if (isFav) html += '<span class="hit-fav-on">►</span>';
                if (h.requesterId && !isBlocked(h.requesterId, h.requester))
                    html += '<button class="hit-bl" data-rid="' + esc(h.requesterId) + '" data-rn="' + esc(h.requester || '') + '">×</button>';
                html += '<div class="hit-sub">';
                if (req) html += '<span class="hit-rq">' + esc(req) + '</span>';
                html += '<span class="hit-tm">' + esc(h.time) + '</span></div></div>';
            }
            el.innerHTML = html;
            var bls = el.getElementsByClassName('hit-bl');
            for (var j = 0; j < bls.length; j++){
                (function(b){ b.onclick = function(ev){ ev.stopPropagation(); if (confirm('Block?')) blockRequester(b.getAttribute('data-rid'), b.getAttribute('data-rn')); }; })(bls[j]);
            }
            var fvs = el.getElementsByClassName('hit-star');
            for (var k = 0; k < fvs.length; k++){
                (function(b){ b.onclick = function(ev){ ev.stopPropagation(); var idx = parseInt(b.getAttribute('data-idx')); if (idx >= 0 && idx < state.acceptedHITs.length && confirm('Focus on this HIT?')) setFavorite(state.acceptedHITs[idx]); }; })(fvs[k]);
            }
        }

        function updateLogDisplay(){
            var el = gel('mrp-activity-log'); if (!el) return;
            var html = '', n = Math.min(state.activityLog.length, 60);
            for (var i = 0; i < n; i++){
                var e = state.activityLog[i];
                html += '<div class="log-e log-' + (e.type || 'info') + '"><span class="log-t">' + esc(e.time) + '</span> ' + esc(e.message) + '</div>';
            }
            el.innerHTML = html || '<div class="log-e log-info">Ready</div>';
            el.scrollTop = 0; // FIX: always show newest entry
        }

        function updateWatchList(){
            var el = gel('mrp-watch-list'); if (!el) return;
            if (!state.watchList.length){ el.innerHTML = '<div class="mrp-empty">No watch IDs</div>'; return; }
            var html = '';
            state.watchList.forEach(function(w, i){
                html += '<div class="w-item"><span class="w-type ' + (w.type === 'requester' ? 'w-req' : 'w-grp') + '">' + (w.type === 'requester' ? 'R' : 'G') + '</span><span class="w-id">' + esc(w.id.substring(0, 16)) + '</span><span class="w-rm" data-idx="' + i + '">×</span></div>';
            });
            el.innerHTML = html;
            var rms = el.getElementsByClassName('w-rm');
            for (var j = 0; j < rms.length; j++){
                (function(b){ b.onclick = function(ev){ ev.stopPropagation(); var idx = parseInt(b.getAttribute('data-idx')); if (idx >= 0 && idx < state.watchList.length){ var rem = state.watchList[idx]; if (groupTimers[rem.id]){ clearInterval(groupTimers[rem.id]); delete groupTimers[rem.id]; } state.watchList.splice(idx, 1); saveState(); updateWatchList(); rebuildUrlPatterns(); } }; })(rms[j]);
            }
        }

        function updateBlockedDisplay(){
            var el = gel('mrp-blocked-list'); if (!el) return;
            var hdrSpan = gel('sh-blockUnblock');
            if (hdrSpan){ var fs = hdrSpan.querySelector('span'); if (fs) fs.textContent = 'Blocked (' + state.blockedRequesters.length + ')'; }
            if (!state.blockedRequesters.length){ el.innerHTML = '<div class="mrp-empty">None</div>'; return; }
            var html = '';
            state.blockedRequesters.forEach(function(b, i){
                html += '<div class="bl-item"><span class="bl-name">' + esc(b.name || b.id) + '</span>' + (b.blockedAt === 'default' ? '<span class="bl-def">D</span>' : '') + '<button class="btn-sm btn-ub" data-idx="' + i + '">✓</button></div>';
            });
            el.innerHTML = html;
            var ubs = el.getElementsByClassName('btn-ub');
            for (var j = 0; j < ubs.length; j++){
                (function(b){ b.onclick = function(ev){ ev.stopPropagation(); var idx = parseInt(b.getAttribute('data-idx')); if (idx >= 0){ var rem = state.blockedRequesters[idx]; state.blockedRequesters.splice(idx, 1); rebuildBlockSets(); saveState(); updateBlockedDisplay(); log('\u2713 Unblocked: ' + (rem.name || rem.id), 'success'); writeBlocklistSignal(); } }; })(ubs[j]); // v25.3: team-wide
            }
        }

        function toggleSection(key){
            var b = gel('b-' + key), a = gel('a-' + key); if (!b) return;
            state.sectionsCollapsed[key] = !state.sectionsCollapsed[key];
            b.style.display = state.sectionsCollapsed[key] ? 'none' : '';
            if (a) a.textContent = state.sectionsCollapsed[key] ? '▸' : '▾';
            saveState();
        }
        function applySections(){
            Object.keys(state.sectionsCollapsed).forEach(function(k){
                var b = gel('b-' + k), a = gel('a-' + k);
                if (b) b.style.display = state.sectionsCollapsed[k] ? 'none' : '';
                if (a) a.textContent = state.sectionsCollapsed[k] ? '▸' : '▾';
            });
        }

        // Panel clock
        function startPanelClock(){
            if (panelClockTimer) clearInterval(panelClockTimer);
            function tick(){
                var d = new Date();
                var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                var ms = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                var ce = gel('mrp-pclock'); if (ce) ce.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
                var de = gel('mrp-pdate'); if (de) de.textContent = days[d.getDay()] + ' ' + ms[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear();
            }
            tick();
            panelClockTimer = setInterval(tick, 1000);
        }

        // ================================================================
        //  BUILD PANEL
        // ================================================================
        function buildPanel(){
            if (panelBuilt || !document.body) return;
            // Respect saved panelVisible — do NOT force true.
            // loadState() already restored the user's last choice.
            // Read the fast GM key first (written by tab toggle, syncs all pages).
            try {
                var vis = GM_getValue('mrp_panel_vis', '');
                if (vis === '1') state.panelVisible = true;
                else if (vis === '0') state.panelVisible = false;
                // '' means never set — fall through to saved state
            } catch(e){}
            // If mrp-panel is somehow already in DOM (shouldn't be), remove it first
            var old = document.getElementById('mrp-panel');
            var oldTab = document.getElementById('mrp-tab');
            if (old) old.remove();
            if (oldTab) oldTab.remove();
            injectCSS();

            var tab = document.createElement('div'); tab.id = 'mrp-tab';
            tab.innerHTML = 'N<br>*<br>M<br>*<br>S<br>*<br>H<br>*<br>N';
            tab.onclick = function(){
                state.panelVisible = !state.panelVisible;
                var p = gel('mrp-panel'); if (p) p.style.display = state.panelVisible ? '' : 'none';
                tab.style.right = state.panelVisible ? '460px' : '0';
                // Write fast GM key — all open tabs read this every 2s and sync
                try { GM_setValue('mrp_panel_vis', state.panelVisible ? '1' : '0'); } catch(e){}
                saveState();
            };
            document.body.appendChild(tab);

            var panel = document.createElement('div'); panel.id = 'mrp-panel';
            if (!state.panelVisible) panel.style.display = 'none';
            tab.style.right = state.panelVisible ? '460px' : '0';

            var wid = LIC.savedWorkerId();
            var widMasked = wid.length > 7 ? wid.substring(0, 4) + '***' + wid.substring(wid.length - 3) : wid;

            var h = '<div class="mrp-in">';

            // Header
            h += '<div class="mrp-hdr">' +
                '<b class="mrp-logo">' + TOOL_NAME + '</b>' +
                '<span class="mrp-hdr-r">' +
                    '<span id="mrp-team-label" class="mrp-team-badge" title="Detecting team...">' + esc(_teamLabel) + '</span>' +
                    '<button class="mb mb-theme" id="mrp-theme-btn">' + (state.darkMode ? 'Dark' : 'Light') + '</button>' +
                    '<span class="mrp-ver">v' + VERSION + '</span>' +
                '</span>' +
            '</div>';

            // License bar
            // License bar — shows worker ID and team
            h += '<div class="lic-bar">' +
                '<div class="lic-bar-l">' +
                    '<div class="lic-bar-clock" id="mrp-pclock">--:--:--</div>' +
                    '<div class="lic-bar-date" id="mrp-pdate">--</div>' +
                '</div>' +
                '<div class="lic-bar-r">' +
                    '<div class="lic-bar-name">' + TOOL_NAME + '</div>' +
                    '<div class="lic-bar-ok">✓ Worker: ' + esc(widMasked) + '</div>' +
                '</div>' +
            '</div>';
            h += '<div class="stat-grid">' +
                '<div class="stat-cell"><div class="stat-label">STATUS</div><div class="mrp-sv sv-off" id="mrp-status-text">IDLE</div></div>' +
                '<div class="stat-cell"><div class="stat-label">CAUGHT</div><div class="mrp-sv sv-good" id="mrp-accepted-count">0</div></div>' +
                '<div class="stat-cell"><div class="stat-label">SCANS</div><div class="mrp-sv" id="mrp-scanned-count">0</div></div>' +
                '<div class="stat-cell"><div class="stat-label">FIRES</div><div class="mrp-sv" id="mrp-attempt-count">0</div></div>' +
                '<div class="stat-cell"><div class="stat-label">UPTIME</div><div class="mrp-sv" id="mrp-uptime">—</div></div>' +
            '</div>';
            h += '<div class="stat-grid stat-grid2">' +
                '<div class="stat-cell"><div class="stat-label">H/MIN</div><div class="mrp-sv sv-good" id="mrp-hpm">0</div></div>' +
                '<div class="stat-cell"><div class="stat-label">PING</div><div class="mrp-sv" id="mrp-speed">—</div></div>' +
                '<div class="stat-cell"><div class="stat-label">FLYING</div><div class="mrp-sv" id="mrp-pending">0</div></div>' +
                '<div class="stat-cell"><div class="stat-label">QUEUE</div><div class="mrp-sv" id="mrp-queue-size">0/25</div></div>' +
                '<div class="stat-cell"><div class="stat-label">FREE</div><div class="mrp-sv sv-good" id="mrp-queue-free">25</div></div>' +
                '<div class="stat-cell"><div class="stat-label">429s</div><div class="mrp-sv sv-warn" id="mrp-busy-count">0</div></div>' +
                '<div class="stat-cell" style="grid-column:span 2"><div class="stat-label">RELOAD IN</div><div class="mrp-sv" id="mrp-reload-cd" style="color:#f39c12">—</div></div>' +
            '</div>';

            // START/STOP row + Min Reward filter
            h += '<div class="mrp-row" style="margin:8px 0">' +
                '<button class="mb mb-start" id="mrp-toggle-btn" style="flex:1;padding:10px;font-size:14px;font-weight:700">START</button>' +
                '<button class="mb mb-tog' + (state.autoStartEnabled ? ' on' : '') + '" id="mrp-autostart-btn" style="margin-left:6px">Auto: ' + (state.autoStartEnabled ? 'ON' : 'OFF') + '</button>' +
            '</div>' +
            '<div class="mrp-min-wrap">' +
                '<div class="mrp-min-hdr">' +
                    '<span class="lbl">Minimum HIT Reward</span>' +
                    '<button id="mrp-reset-reward" class="mrp-reset-btn" title="Reset to $0.00">⟳ Reset</button>' +
                    '<div class="mrp-min-inp-wrap">' +
                        '<span class="mrp-min-sym">$</span>' +
                        '<input type="number" class="mrp-min-inp" id="mrp-min-type" ' +
                            'min="0" max="100" step="0.01" ' +
                            'value="' + state.minReward.toFixed(2) + '" placeholder="0.00">' +
                    '</div>' +
                '</div>' +
                '<input type="range" class="mrp-slider" id="mrp-min-reward" ' +
                    'min="0" max="10000" step="1" ' +
                    'value="' + Math.round(state.minReward * 100) + '">' +
                '<div class="mrp-min-ticks"><span>$0</span><span>$25</span><span>$50</span><span>$75</span><span>$100</span></div>' +
            '</div>';

            // MEGA button hidden — logic runs silently in background
            h += '<div style="display:none">' +
                '<button class="mb" id="mrp-mega-btn">⚡ MEGA</button>' +
                '<div id="mrp-mega-msg"></div>' +
                '</div>';

            h += sec('captchaSection', 'Captcha Guard',
                '<div class="mrp-row"><button class="mb mb-tog' + (state.captchaProbeEnabled ? ' on' : '') + '" id="mrp-probe-btn">Probe: ' + (state.captchaProbeEnabled ? 'ON' : 'OFF') + '</button><button class="mb mb-test" id="mrp-probe-now">Probe Now</button><div class="mrp-f"><label class="lbl">Every (min)</label><input class="inp inp-sm" id="mrp-probe-min" value="' + state.captchaProbeMinutes + '"></div></div>');

            h += sec('favoriteSection', 'Favorite Focus',
                '<div id="mrp-fav-display"><div class="mrp-empty">Click ★ on a caught HIT to focus</div></div>' +
                '<div class="mrp-row mt4"><div class="mrp-f"><label class="lbl">Speed ms</label><input class="inp inp-sm" id="mrp-fav-speed" value="' + state.favoriteFocusInterval + '"></div><div class="mrp-f"><label class="lbl">Group ID</label><input class="inp" id="mrp-fav-manual" placeholder="paste ID.."></div><button class="mb mb-add" id="mrp-fav-manual-btn">SET</button></div>' +
                '<button class="mb mb-clear-fav" id="mrp-clear-fav-big">CLEAR FAVORITE</button>');

            h += '<div class="caught-box" id="mrp-accepted-list"><div class="mrp-empty">No HITs caught yet</div></div>';

            h += sec('watchSection', 'Watch IDs',
                '<div class="mrp-row"><input class="inp" id="mrp-add-input" placeholder="Requester/Group ID or URL.."><button class="mb mb-add" id="mrp-add-btn">+</button></div>' +
                '<div id="mrp-watch-list"></div>');



            h += sec('blockUnblock', 'Blocked (' + state.blockedRequesters.length + ')',
                '<div id="mrp-blocked-list"></div><div class="divider"></div>' +
                '<div class="mrp-row"><input class="inp" id="mrp-block-inp" placeholder="ID or name.."><button class="mb mb-add" id="mrp-block-btn">Block</button></div>' +
                '<div class="divider"></div><button class="mb mb-restore" id="mrp-restore-defaults">Restore Defaults</button>');

            h += sec('tools', 'Tools',
                '<div class="mrp-row"><button class="mb mb-misc" id="mrp-clr-btn">Clear Log</button><button class="mb mb-misc" id="mrp-sync-btn">Sync Queue</button><button class="mb mb-misc" id="mrp-return-btn">Return All</button></div>');

            // License section hidden — auth is fully automatic now
            // h += sec('licenseInfo', ...  — removed

            h += sec('activityLog', 'Activity Log',
                '<div class="log-box" id="mrp-activity-log"><div class="log-e log-info">Ready</div></div>');
            h += '</div>';

            panel.innerHTML = h;
            document.body.appendChild(panel);
            panelBuilt = true;

            applyTheme(); bindEvents();
            updateWatchList(); updateBlockedDisplay();

            updateAcceptedDisplay(); updateLogDisplay(); updateFavoriteDisplay();
            applySections(); updateToggleBtn(); updateStatusDisplay();
            // Sync MEGA state from global key — another tab may have set it
            state.megaActive = isMegaGlobalOn();
            startPanelClock();

            log(TOOL_NAME + ' VACUUM v' + VERSION + ' ready · Worker ' + widMasked, 'success');

            // Auto-start check — three triggers:
            // 1. Normal: was running before page reload (state.wasRunning saved to disk)
            // 2. Captcha solved: CAP_RESUME flag was set before captcha tab redirected here
            // 3. First run: autoStartEnabled + wasRunning from saved state
            var capResume = false;
            try { capResume = GM_getValue(CAP_RESUME, '0') === '1'; } catch(e){}
            if (capResume){
                try { GM_setValue(CAP_RESUME, '0'); } catch(e){}
                log('✓ CAPTCHA solved — auto-resuming scan...', 'success');
                if (!isMegaGlobalOn()) setTimeout(startScan, 600);
            } else if (state.autoStartEnabled && state.wasRunning && !runtime.isRunning){
                log('Auto-starting (was running before reload)...', 'info');
                if (!isMegaGlobalOn()) setTimeout(startScan, 800);
            }
        }

        function sec(key, title, content){
            return '<div class="mrp-sec"><div class="sec-hdr" id="sh-' + key + '"><span>' + title + '</span><span class="sec-arrow" id="a-' + key + '">▾</span></div><div class="sec-body" id="b-' + key + '">' + content + '</div></div>';
        }

        // ================================================================
        //  EVENTS
        // ================================================================
        function bindEvents(){
            clk('mrp-toggle-btn', function(){ runtime.isRunning ? stopScan(false) : startScan(); });
            clk('mrp-theme-btn', toggleTheme);
            clk('mrp-autostart-btn', function(){
                state.autoStartEnabled = !state.autoStartEnabled;
                var b = gel('mrp-autostart-btn');
                if (b){ b.textContent = 'Auto: ' + (state.autoStartEnabled ? 'ON' : 'OFF'); b.className = 'mb mb-tog' + (state.autoStartEnabled ? ' on' : ''); }
                saveState();
            });
            clk('mrp-add-btn', function(){ var i = gel('mrp-add-input'); if (i && i.value.trim()){ addToWatch(i.value.trim()); i.value = ''; } });
            ent('mrp-add-input', function(){ var b = gel('mrp-add-btn'); if (b) b.click(); });
            clk('mrp-clear-fav-big', clearFavorite);
            clk('mrp-probe-btn', function(){
                state.captchaProbeEnabled = !state.captchaProbeEnabled;
                var b = gel('mrp-probe-btn');
                if (b){ b.textContent = 'Probe: ' + (state.captchaProbeEnabled ? 'ON' : 'OFF'); b.className = 'mb mb-tog' + (state.captchaProbeEnabled ? ' on' : ''); }
                saveState();
                if (state.captchaProbeEnabled && runtime.isRunning){ captchaSystem.probeInterval = state.captchaProbeMinutes * 60000; captchaSystem.startProbe(); }
                else captchaSystem.stopProbe();
            });
            clk('mrp-probe-now', function(){ captchaSystem.lastProbe = 0; captchaSystem.probe(); });
            chg('mrp-probe-min', function(v){ state.captchaProbeMinutes = Math.max(1, Math.min(60, parseInt(v) || 10)); var e = gel('mrp-probe-min'); if (e) e.value = state.captchaProbeMinutes; captchaSystem.probeInterval = state.captchaProbeMinutes * 60000; saveState(); });
            // Min reward — slider + type input stay in sync
            var sliderEl  = gel('mrp-min-reward');
            var typeEl    = gel('mrp-min-type');
            function updateSliderFill(el){
                if (!el) return;
                var pct = (parseInt(el.value) / 10000 * 100).toFixed(1);
                el.style.background = 'linear-gradient(to right,#2ecc71 ' + pct + '%,#222 ' + pct + '%)';
            }
            function applyReward(dollars){
                dollars = Math.max(0, Math.min(100, parseFloat(dollars) || 0));
                state.minReward = dollars;
                lastSyncedReward = dollars; // prevent poller from re-applying own change
                if (sliderEl){ sliderEl.value = Math.round(dollars * 100); updateSliderFill(sliderEl); }
                if (typeEl) typeEl.value = dollars.toFixed(2);
                saveState();
                // Broadcast to all team members (same-browser + cross-browser)
                writeRewardSignal(dollars);
            }
            clk('mrp-reset-reward', function(){ applyReward(0); });
            if (sliderEl){
                updateSliderFill(sliderEl);
                sliderEl.oninput = function(){ applyReward(parseInt(this.value) / 100); };
            }
            if (typeEl){
                typeEl.onchange = function(){ applyReward(this.value); };
                typeEl.onkeydown = function(e){ if (e.key === 'Enter') applyReward(this.value); };
            }
            chg('mrp-fav-speed', function(v){ state.favoriteFocusInterval = Math.max(30, Math.min(2000, parseInt(v) || 60)); var e = gel('mrp-fav-speed'); if (e) e.value = state.favoriteFocusInterval; saveState(); if (state.favoriteMode){ stopFavoriteCatcher(); startFavoriteCatcher(); } });
            clk('mrp-fav-manual-btn', function(){ var i = gel('mrp-fav-manual'); if (!i || !i.value.trim()) return; var gid = extractId(i.value.trim()); if (gid){ setFavorite({ id: gid, groupId: gid, title: 'Manual: ' + gid.substring(0, 14) }); i.value = ''; } });
            clk('mrp-block-btn', function(){ var i = gel('mrp-block-inp'); if (!i || !i.value.trim()) return; var val = i.value.trim(); if (classifyId(val) === 'requester') blockRequester(val, knownRequesters[val] || ''); else blockRequester('', val); i.value = ''; });
            ent('mrp-block-inp', function(){ var b = gel('mrp-block-btn'); if (b) b.click(); });
            clk('mrp-restore-defaults', function(){ ensureBlocked(); saveState(); updateBlockedDisplay(); log('Defaults restored', 'success'); });
            clk('mrp-mega-btn', toggleMega);
            clk('mrp-clr-btn', function(){ state.activityLog = []; updateLogDisplay(); });
            clk('mrp-sync-btn', function(){ syncQueue(function(){ log('Queue: ' + runtime.queueSize + '/25', 'success'); updateStatusDisplay(); }); });
            clk('mrp-return-btn', returnAllHITs);

            // Re-verify is fully automatic — removed manual button

            ['captchaSection','favoriteSection','watchSection','blockUnblock','tools','activityLog'].forEach(function(k){
                var h = gel('sh-' + k); if (h) h.onclick = function(){ toggleSection(k); };
            });
        }

        function clk(id, fn){ var e = gel(id); if (e) e.onclick = function(ev){ ev.stopPropagation(); fn(); }; }
        function ent(id, fn){ var e = gel(id); if (e) e.onkeydown = function(ev){ if (ev.key === 'Enter') fn(); }; }
        function chg(id, fn){ var e = gel(id); if (e) e.onchange = function(){ fn(this.value); }; }

        // ================================================================
        //  CSS
        // ================================================================
        function injectCSS(){
            var css =
            '#mrp-panel,#mrp-panel *,#mrp-tab{-webkit-font-smoothing:antialiased}' +
            '.mrp-tab-d{position:fixed;top:50%;transform:translateY(-50%);z-index:2147483647;background:#111;color:#e74c3c;padding:8px 5px;cursor:pointer;font:900 9px/1.3 system-ui;letter-spacing:1px;text-align:center;border-radius:6px 0 0 6px;border:1px solid #333;border-right:0;user-select:none;transition:right .25s;min-height:80px;display:flex;align-items:center;justify-content:center}' +
            '.mrp-tab-d:hover{background:#1a1a1a}' +
            '.mrp-tab-l{position:fixed;top:50%;transform:translateY(-50%);z-index:2147483647;background:#fff;color:#c0392b;padding:8px 5px;cursor:pointer;font:900 9px/1.3 system-ui;letter-spacing:1px;text-align:center;border-radius:6px 0 0 6px;border:1px solid #ccc;border-right:0;user-select:none;transition:right .25s;display:flex;align-items:center;justify-content:center}' +
            '.mrp-dark{position:fixed;top:0;right:0;width:460px;height:100vh;overflow-y:auto;z-index:2147483646;font:11px/1.35 system-ui,sans-serif;background:#0a0a0a;border-left:1px solid #222;color:#ccc}' +
            '.mrp-light{position:fixed;top:0;right:0;width:460px;height:100vh;overflow-y:auto;z-index:2147483646;font:11px/1.35 system-ui,sans-serif;background:#f9f9f9;border-left:1px solid #ddd;color:#333}' +
            '.lic-bar{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#0e1a0e,#111);border:1px solid #1a2a1a;border-radius:6px;padding:8px 12px;margin-bottom:6px}' +
            '.mrp-light .lic-bar{background:linear-gradient(135deg,#edfaed,#f5f5f5);border-color:#c8e6c9}' +
            '.lic-bar-clock{font:900 26px/1 Consolas,monospace;color:#2ecc71;letter-spacing:3px;text-shadow:0 0 12px rgba(46,204,113,.3)}' +
            '.mrp-light .lic-bar-clock{color:#27ae60;text-shadow:none}' +
            '.lic-bar-date{font:600 7px system-ui;color:#555;margin-top:3px}' +
            '.mrp-light .lic-bar-date{color:#888}' +
            '.lic-bar-r{text-align:right}' +
            '.lic-bar-name{font:900 10px system-ui;color:#e74c3c;letter-spacing:2px}' +
            '.lic-bar-ok{font:700 8px system-ui;color:#2ecc71;margin-top:2px}' +
            '.mrp-light .lic-bar-ok{color:#27ae60}' +
            '.lic-bar-days{font:600 7px system-ui;color:#f39c12;margin-top:1px}' +
            '.lic-info-box{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:4px;padding:6px;margin-bottom:6px}' +
            '.mrp-light .lic-info-box{background:#f5f5f5;border-color:#eee}' +
            '.lic-info-row{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #151515;font:600 8px system-ui}' +
            '.mrp-light .lic-info-row{border-bottom-color:#eee}' +
            '.lic-il{color:#555}.lic-iv{color:#aaa;font-weight:700}' +
            '.mrp-light .lic-iv{color:#333}' +
            '.lic-exp{color:#e74c3c!important}.lic-days{color:#2ecc71!important}' +
            '.mrp-light .lic-days{color:#27ae60!important}' +
            '.mb-reauth{background:#8e44ad;color:#fff;border:none;border-radius:3px;font:700 9px system-ui;cursor:pointer;padding:5px}' +
            '.mrp-dark .mrp-in{padding:7px}.mrp-dark .mrp-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid #222}' +
            '.mrp-dark .mrp-logo{font:900 14px system-ui;color:#e74c3c;letter-spacing:3px}' +
            '.mrp-dark .mrp-ver{font:700 8px system-ui;color:#555;background:#151515;padding:2px 6px;border-radius:3px}' +
            '.mrp-dark .stat-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;margin-bottom:2px}' +
            '.mrp-dark .stat-grid2{grid-template-columns:repeat(6,1fr);margin-bottom:6px}' +
            '.mrp-dark .stat-cell{background:#111;padding:4px 2px;text-align:center;border:1px solid #1a1a1a}' +
            '.mrp-dark .stat-label{font:800 6px system-ui;color:#666;letter-spacing:.5px;text-transform:uppercase}' +
            '.mrp-dark .mrp-sv{font:900 12px system-ui;color:#aaa}' +
            '.mrp-dark .sv-on{color:#2ecc71}.mrp-dark .sv-off{color:#555}.mrp-dark .sv-fav{color:#f1c40f}.mrp-dark .sv-err{color:#e74c3c}.mrp-dark .sv-good{color:#2ecc71}.mrp-dark .sv-warn{color:#e67e22}' +
            '.mrp-dark .mrp-sec{background:#0f0f0f;border:1px solid #1c1c1c;border-radius:4px;margin-bottom:4px}' +
            '.mrp-dark .sec-hdr{display:flex;justify-content:space-between;align-items:center;padding:5px 7px;cursor:pointer;font:700 10px system-ui;color:#bbb;user-select:none}' +
            '.mrp-dark .sec-hdr:hover{background:#151515}.mrp-dark .sec-arrow{color:#555;font-size:10px}' +
            '.mrp-dark .sec-body{padding:6px 7px;border-top:1px solid #1c1c1c}' +
            '.mrp-dark .inp{padding:4px 6px;border:1px solid #2a2a2a;border-radius:3px;font:600 10px system-ui;background:#0a0a0a;color:#ccc;box-sizing:border-box;outline:0;width:100%}' +
            '.mrp-dark .inp:focus{border-color:#e74c3c}' +
            '.mrp-dark .caught-box{background:#0d0d0d;border:1px solid #1c1c1c;border-radius:4px;padding:4px 5px;margin-bottom:5px;max-height:220px;overflow-y:auto}' +
            '.mrp-dark .hit-row{padding:3px 0;border-bottom:1px solid #161616;display:grid;grid-template-columns:auto 1fr auto auto auto;align-items:center;gap:3px}' +
            '.mrp-dark .hit-fav{border-left:2px solid #f1c40f;padding-left:4px}' +
            '.mrp-dark .hit-ck{color:#2ecc71;font:900 10px system-ui}.mrp-dark .hit-tt{color:#bbb;font:600 10px system-ui;overflow:hidden;white-space:nowrap}' +
            '.mrp-dark .hit-rw{color:#f1c40f;font:800 10px system-ui}' +
            '.mrp-dark .hit-sub{grid-column:1/-1;padding-left:14px;display:flex;gap:6px}' +
            '.mrp-dark .hit-rq{color:#777;font:600 8px system-ui}.mrp-dark .hit-tm{color:#444;font:600 7px system-ui}' +
            '.mrp-dark .hit-star{background:none;border:1px solid #f1c40f;color:#f1c40f;border-radius:2px;padding:0 3px;font-size:9px;cursor:pointer;opacity:.4}' +
            '.mrp-dark .hit-star:hover{opacity:1;background:#f1c40f;color:#000}' +
            '.mrp-dark .hit-fav-on{color:#f1c40f;font-size:9px}' +
            '.mrp-dark .hit-bl{background:#c0392b;color:#fff;border:none;border-radius:2px;padding:0 3px;font:800 8px system-ui;cursor:pointer;opacity:.4}' +
            '.mrp-dark .hit-bl:hover{opacity:1}' +
            '.mrp-dark .log-box{max-height:130px;overflow-y:auto;background:#080808;border:1px solid #1c1c1c;border-radius:3px;padding:2px}' +
            '.mrp-dark .log-e{padding:1px 4px;margin-bottom:1px;font:600 8px/1.2 Consolas,monospace}' +
            '.mrp-dark .log-t{color:#444;font-size:7px}' +
            '.mrp-dark .log-info{color:#2ecc71;background:#0a1a0a}.mrp-dark .log-success{color:#00ff88;background:#001a00;font-weight:800}' +
            '.mrp-dark .log-warning{color:#f39c12;background:#1a1500}.mrp-dark .log-error{color:#e74c3c;background:#1a0a0a;font-weight:800}' +
            '.mrp-dark .bl-item{display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid #161616;font:600 9px system-ui}' +
            '.mrp-dark .bl-name{color:#e74c3c;flex:1}.mrp-dark .bl-def{font:700 6px system-ui;color:#555;background:#1a1a1a;padding:1px 4px;border-radius:3px}' +
            '.mrp-dark .w-item{display:flex;align-items:center;gap:3px;padding:2px 0;border-bottom:1px solid #161616;font:600 9px system-ui}' +
            '.mrp-dark .w-id{font:700 8px Consolas,monospace;color:#777;flex:1}' +
            '.mrp-dark .w-rm{cursor:pointer;color:#e74c3c;font:900 12px system-ui}.mrp-dark .w-rm:hover{color:#f00}' +
            '.mrp-dark .sg-item{display:flex;align-items:center;gap:3px;padding:2px 0;border-bottom:1px solid #161616;font:600 9px system-ui}' +
            '.mrp-dark .sg-n{color:#bbb;flex:1}.mrp-dark .mrp-empty{color:#444;font:italic 600 8px system-ui}' +
            '.mrp-dark .fav-box{border:1px solid #f1c40f;border-radius:4px;padding:7px;background:rgba(241,196,15,.03);position:relative}' +
            '.mrp-dark .fav-t{color:#f1c40f;font:900 11px system-ui}.mrp-dark .fav-r{color:#2ecc71;font:800 10px system-ui;margin-left:6px}' +
            '.mrp-dark .fav-req{color:#777;font:600 9px system-ui;margin-top:2px}' +
            '.mrp-dark .fav-stats{font:600 8px system-ui;color:#888;margin-top:3px}.mrp-dark .fav-got{color:#2ecc71}' +
            '.mrp-light .mrp-in{padding:7px}.mrp-light .mrp-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid #ddd}' +
            '.mrp-light .mrp-logo{font:900 14px system-ui;color:#c0392b;letter-spacing:3px}' +
            '.mrp-light .mrp-ver{font:700 8px system-ui;color:#999;background:#eee;padding:2px 6px;border-radius:3px}' +
            '.mrp-light .stat-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;margin-bottom:2px}' +
            '.mrp-light .stat-grid2{grid-template-columns:repeat(6,1fr);margin-bottom:6px}' +
            '.mrp-light .stat-cell{background:#fff;padding:4px 2px;text-align:center;border:1px solid #eee}' +
            '.mrp-light .stat-label{font:800 6px system-ui;color:#999;letter-spacing:.5px;text-transform:uppercase}' +
            '.mrp-light .mrp-sv{font:900 12px system-ui;color:#333}' +
            '.mrp-light .sv-on{color:#27ae60}.mrp-light .sv-off{color:#bbb}.mrp-light .sv-fav{color:#f39c12}.mrp-light .sv-err{color:#e74c3c}.mrp-light .sv-good{color:#27ae60}.mrp-light .sv-warn{color:#e67e22}' +
            '.mrp-light .mrp-sec{background:#fff;border:1px solid #e5e5e5;border-radius:4px;margin-bottom:4px}' +
            '.mrp-light .sec-hdr{display:flex;justify-content:space-between;align-items:center;padding:5px 7px;cursor:pointer;font:700 10px system-ui;color:#333;user-select:none}' +
            '.mrp-light .sec-hdr:hover{background:#f5f5f5}.mrp-light .sec-arrow{color:#aaa;font-size:10px}' +
            '.mrp-light .sec-body{padding:6px 7px;border-top:1px solid #eee}' +
            '.mrp-light .inp{padding:4px 6px;border:1px solid #ccc;border-radius:3px;font:600 10px system-ui;background:#fff;color:#333;box-sizing:border-box;outline:0;width:100%}' +
            '.mrp-light .inp:focus{border-color:#c0392b}' +
            '.mrp-light .caught-box{background:#1e2d3d;border:1px solid #2c3e50;border-radius:4px;padding:4px 5px;margin-bottom:5px;max-height:220px;overflow-y:auto}' +
            '.mrp-light .hit-row{padding:3px 0;border-bottom:1px solid #2c3e50;display:grid;grid-template-columns:auto 1fr auto auto auto;align-items:center;gap:3px}' +
            '.mrp-light .hit-fav{border-left:2px solid #f1c40f;padding-left:4px}' +
            '.mrp-light .hit-ck{color:#2ecc71;font:900 10px system-ui}.mrp-light .hit-tt{color:#ecf0f1;font:600 10px system-ui;overflow:hidden;white-space:nowrap}' +
            '.mrp-light .hit-rw{color:#f1c40f;font:800 10px system-ui}' +
            '.mrp-light .hit-sub{grid-column:1/-1;padding-left:14px;display:flex;gap:6px}' +
            '.mrp-light .hit-rq{color:#95a5a6;font:600 8px system-ui}.mrp-light .hit-tm{color:#7f8c8d;font:600 7px system-ui}' +
            '.mrp-light .hit-star{background:none;border:1px solid #f1c40f;color:#f1c40f;border-radius:2px;padding:0 3px;font-size:9px;cursor:pointer;opacity:.4}' +
            '.mrp-light .hit-star:hover{opacity:1;background:#f1c40f;color:#000}' +
            '.mrp-light .hit-fav-on{color:#f1c40f;font-size:9px}' +
            '.mrp-light .hit-bl{background:#c0392b;color:#fff;border:none;border-radius:2px;padding:0 3px;font:800 8px system-ui;cursor:pointer;opacity:.4}' +
            '.mrp-light .hit-bl:hover{opacity:1}' +
            '.mrp-light .log-box{max-height:130px;overflow-y:auto;background:#fafafa;border:1px solid #eee;border-radius:3px;padding:2px}' +
            '.mrp-light .log-e{padding:1px 4px;margin-bottom:1px;font:600 8px/1.2 Consolas,monospace}' +
            '.mrp-light .log-t{color:#aaa;font-size:7px}' +
            '.mrp-light .log-info{color:#27ae60;background:#edf7ed}.mrp-light .log-success{color:#155724;background:#d4edda;font-weight:800}' +
            '.mrp-light .log-warning{color:#856404;background:#fff3cd}.mrp-light .log-error{color:#721c24;background:#f8d7da;font-weight:800}' +
            '.mrp-light .bl-item{display:flex;align-items:center;gap:4px;padding:2px 0;border-bottom:1px solid #eee;font:600 9px system-ui}' +
            '.mrp-light .bl-name{color:#e74c3c;flex:1}.mrp-light .bl-def{font:700 6px system-ui;color:#999;background:#f0f0f0;padding:1px 4px;border-radius:3px}' +
            '.mrp-light .w-item{display:flex;align-items:center;gap:3px;padding:2px 0;border-bottom:1px solid #eee;font:600 9px system-ui}' +
            '.mrp-light .w-id{font:700 8px Consolas,monospace;color:#666;flex:1}' +
            '.mrp-light .w-rm{cursor:pointer;color:#e74c3c;font:900 12px system-ui}' +
            '.mrp-light .sg-item{display:flex;align-items:center;gap:3px;padding:2px 0;border-bottom:1px solid #eee;font:600 9px system-ui}' +
            '.mrp-light .sg-n{color:#333;flex:1}.mrp-light .mrp-empty{color:#aaa;font:italic 600 8px system-ui}' +
            '.mrp-light .fav-box{border:1px solid #f39c12;border-radius:4px;padding:7px;background:rgba(243,156,18,.04);position:relative}' +
            '.mrp-light .fav-t{color:#e67e22;font:900 11px system-ui}.mrp-light .fav-r{color:#27ae60;font:800 10px system-ui;margin-left:6px}' +
            '.mrp-light .fav-req{color:#777;font:600 9px system-ui;margin-top:2px}' +
            '.mrp-light .fav-stats{font:600 8px system-ui;color:#888;margin-top:3px}.mrp-light .fav-got{color:#27ae60}' +
            '.mrp-team-badge{display:inline-block;padding:2px 7px;border-radius:10px;font:900 9px system-ui;letter-spacing:1px;background:linear-gradient(135deg,#8e44ad,#6c3483);color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.4);box-shadow:0 1px 4px rgba(142,68,173,.4);cursor:default}' +
            '.mrp-light .mrp-team-badge{background:linear-gradient(135deg,#9b59b6,#8e44ad)}' +
            '.inp-sm{max-width:48px}.mrp-row{display:flex;gap:3px;align-items:flex-end;flex-wrap:wrap}' +
            '.mt4{margin-top:4px}.divider{height:1px;background:currentColor;opacity:.08;margin:4px 0}' +
            '.mrp-f{flex:1;min-width:44px}' +
            '.mrp-min-wrap{background:#090909;border:1px solid #262626;border-radius:8px;padding:10px 12px;margin-bottom:8px;box-shadow:inset 0 1px 0 rgba(255,255,255,.02)}' +
            '.mrp-min-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}' +
            '.mrp-min-inp-wrap{display:flex;align-items:center;background:#111;border:1px solid #2ecc71;border-radius:6px;overflow:hidden}' +
            '.mrp-min-sym{color:#2ecc71;font:800 12px Consolas,monospace;padding:0 4px 0 7px}' +
            '.mrp-min-inp{width:58px;padding:4px 6px 4px 0;background:transparent;border:none;color:#2ecc71;font:800 12px Consolas,monospace;outline:none;text-align:right}' +
            '.mrp-min-inp::-webkit-inner-spin-button,.mrp-min-inp::-webkit-outer-spin-button{-webkit-appearance:none}' +
            '.mrp-slider{width:100%;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:linear-gradient(to right,#2ecc71 0%,#2ecc71 0%,#222 0%);outline:none;cursor:pointer;margin:2px 0 6px}' +
            '.mrp-slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#2ecc71;cursor:pointer;box-shadow:0 0 6px rgba(46,204,113,.5);transition:box-shadow .15s}' +
            '.mrp-slider::-webkit-slider-thumb:hover{box-shadow:0 0 10px rgba(46,204,113,.8)}' +
            '.mrp-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#2ecc71;cursor:pointer;border:none;box-shadow:0 0 6px rgba(46,204,113,.5)}' +
            '.mrp-slider::-moz-range-track{height:4px;background:#222;border-radius:2px}' +
            '.mrp-min-ticks{display:flex;justify-content:space-between;font:500 8px system-ui;color:#555;margin-top:0px}'+ '.mrp-reset-btn{padding:3px 9px;background:rgba(231,76,60,.12);border:1px solid rgba(231,76,60,.35);color:#e74c3c;border-radius:4px;font:700 8px system-ui;cursor:pointer;letter-spacing:.3px;transition:all .15s;white-space:nowrap}'+ '.mrp-reset-btn:hover{background:#e74c3c;color:#fff;border-color:#e74c3c}' +
            '.lbl{display:block;font:800 7px system-ui;color:inherit;opacity:.5;text-transform:uppercase;margin-bottom:1px;letter-spacing:.8px}' +
            '.fav-top{display:flex;align-items:center;gap:4px}' +
            
            '.mb-vacuum{padding:5px 12px;font:900 11px system-ui;border-radius:4px;border:2px solid #555;background:#222;color:#888;cursor:pointer}' +
            '.mb-vacuum.on{background:#27ae60;color:#fff;border-color:#27ae60;animation:vacP 2s infinite}' +
            '@keyframes vacP{0%,100%{box-shadow:0 0 0 0 rgba(39,174,96,.4)}50%{box-shadow:0 0 0 6px rgba(39,174,96,0)}}' +
            '@keyframes megaPulse{0%,100%{box-shadow:0 0 0 0 rgba(231,76,60,.5)}50%{box-shadow:0 0 0 8px rgba(231,76,60,0)}}' +
            '.mrp-light .mb-vacuum{background:#eee;color:#999;border-color:#ccc}' +
            '.mrp-light .mb-vacuum.on{background:#27ae60;color:#fff;border-color:#27ae60}' +
            '.mb{padding:4px 7px;border:none;border-radius:3px;font:700 9px system-ui;cursor:pointer;white-space:nowrap;transition:opacity .1s}.mb:hover{opacity:.8}' +
            '.mb-start{background:#27ae60;color:#fff;font-size:11px;font-weight:900;padding:5px 12px}' +
            '.mb-stop{background:#c0392b;color:#fff;font-size:11px;font-weight:900;padding:5px 12px}' +
            '.mb-add{background:#e74c3c;color:#fff}.mb-misc{background:#7f8c8d;color:#fff}' +
            '.mb-test{background:#e67e22;color:#fff}' +
            '.mb-theme{background:#34495e;color:#fff;border-radius:3px;padding:3px 7px;font-size:8px}' +
            '.mb-return{display:block;width:100%;padding:8px;margin-bottom:5px;background:#e67e22;color:#fff;border:none;border-radius:4px;font:900 12px system-ui;cursor:pointer;text-align:center}' +
            '.mb-restore{background:#8e44ad;color:#fff;width:100%;padding:4px;border:none;border-radius:3px;font:700 9px system-ui;cursor:pointer}' +
            '.mb-clear-fav{display:block;width:100%;margin-top:5px;padding:6px;background:#c0392b;color:#fff;border:none;border-radius:3px;font:800 10px system-ui;cursor:pointer;text-align:center}' +
            '.mb-clear{background:#c0392b;color:#fff;position:absolute;top:4px;right:4px;padding:2px 6px;font:700 8px system-ui;border:none;border-radius:2px;cursor:pointer}' +
            '.mb-tog{background:#ddd;color:#888;border-radius:3px;padding:3px 6px;border:1px solid #ccc;font:700 8px system-ui}' +
            '.mb-tog.on{background:#27ae60;color:#fff;border-color:#27ae60}' +
            '.btn-sm{padding:1px 4px;border:none;border-radius:2px;font:700 7px system-ui;cursor:pointer;margin-left:1px}' +
            '.btn-w{background:#f39c12;color:#fff}.btn-d{background:#e74c3c;color:#fff}.btn-ub{background:#27ae60;color:#fff}' +
            '.w-type{padding:1px 3px;border-radius:2px;font:900 6px system-ui;color:#fff}' +
            '.w-req{background:#8e44ad}.w-grp{background:#e67e22}' +
            '.chip{display:inline-block;padding:2px 6px;border-radius:3px;font:700 8px system-ui;cursor:pointer;border:1px solid #ccc;background:#eee;color:#666;margin:1px;user-select:none}' +
            '.chip:hover{background:#3498db;color:#fff;border-color:#3498db}' +
            '.chip-on{background:#27ae60;color:#fff;border-color:#27ae60}' +
            '#mrp-panel::-webkit-scrollbar{width:3px}#mrp-panel::-webkit-scrollbar-thumb{background:#444;border-radius:2px}' +
            '.log-box::-webkit-scrollbar,.caught-box::-webkit-scrollbar{width:2px}' +
            '.log-box::-webkit-scrollbar-thumb,.caught-box::-webkit-scrollbar-thumb{background:#555;border-radius:1px}';
            try { GM_addStyle(css); } catch(e){ var s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); }
        }

        // ── INIT ──
        loadState();
        preFetchSounds();

        // ── TEAM DETECTION — MUST complete before poller starts ──
        // Poller is intentionally NOT started here.
        // It starts inside the detectTeam callback once _teamKey is confirmed.
        // This guarantees no account ever writes/reads the wrong team signal.
        var _savedWid = LIC.savedWorkerId();

        function initTeamAndPoller() {
            if (!_savedWid) {
                // No worker ID yet — use timestamp as unique fallback, try again in 3s
                _teamKey   = 'WID_UNKNOWN'; // v25.2: static fallback — avoid GM storage key leak
                _teamLabel = '?';
                setTimeout(initTeamAndPoller, 3000);
                return;
            }

            detectTeam(_savedWid, function(key, label, rawName) {
                // If sheet unreachable or ID not found, use worker ID as team key.
                // This makes every unassigned account self-isolated — they never
                // share a signal with any other account.
                if (!key || key === 'DEFAULT') {
                    _teamKey   = 'WID_' + _savedWid.toUpperCase();
                    _teamLabel = _savedWid.substring(0, 4) + '..';
                    log('Team: not found in sheet — isolated (key: ' + _teamKey + ')', 'warning');
                } else {
                    _teamKey   = key;
                    _teamLabel = label;
                    log('Team: ' + (rawName || key) + ' → key: ' + key, 'success');
                }

                // Update badge if panel already built
                var el = document.getElementById('mrp-team-label');
                if (el) { el.textContent = _teamLabel; el.title = rawName || _teamKey; }

                // NOW safe to start the pollers — _teamKey is locked in
                startGlobalPoller();
                startRewardPoller();    // reward sync
                startBlocklistPoller(); // team block sync
            });
        }

        initTeamAndPoller();
        function tryBuild(){ if (document.body) buildPanel(); else setTimeout(tryBuild, 50); }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryBuild);
        setTimeout(tryBuild, 15);
        setTimeout(function(){ if (!panelBuilt) tryBuild(); }, 1200);
        window.addEventListener('load', function(){ if (!panelBuilt) buildPanel(); });

        // ── SPA NAVIGATION — MTurk is a React SPA ──
        // When React navigates, it tears down the DOM and removes the panel.
        // Detect removal and re-inject immediately.

        // Method 1: MutationObserver on document.body — catches React DOM wipes
        function startPanelGuard(){
            if (typeof MutationObserver === 'undefined') return;
            var rebuildPending = false;
            var obs = new MutationObserver(function(){
                // Only act if panel was confirmed built AND is now gone from DOM
                // Use panelBuilt as gate — avoids firing during initial build sequence
                if (!panelBuilt) return;
                if (document.getElementById('mrp-panel')) return; // still there
                // Panel is gone — debounce re-injection so React finishes its render
                if (rebuildPending) return;
                rebuildPending = true;
                panelBuilt = false;
                setTimeout(function(){
                    rebuildPending = false;
                    if (!panelBuilt) tryBuild();
                }, 120);
            });
            function attachObs(){
                if (document.body) obs.observe(document.body, { childList: true, subtree: false });
            }
            if (document.body) attachObs();
            else document.addEventListener('DOMContentLoaded', attachObs);
        }
        startPanelGuard();

        // Method 2: History API — catches pushState / replaceState SPA navigation
        (function(){
            function onNav(){ setTimeout(tryBuild, 80); }
            window.addEventListener('popstate', onNav);
            var _push = history.pushState;
            var _replace = history.replaceState;
            history.pushState = function(){ _push.apply(history, arguments); onNav(); };
            history.replaceState = function(){ _replace.apply(history, arguments); onNav(); };
        })();

    } // end initMain

})();
