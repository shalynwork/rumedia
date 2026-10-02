// ==UserScript==
// @name         RuMedia Moderation (new site)
// @namespace    https://dev.rumedia.io/
// @version      0.1.0
// @description  Очередь модерации на новом сайте: вкладки Альбомы/Синглы и PRO/Обычные, только релизы «Ожидает», вся информация о релизе сразу на странице.
// @author       Ruslan
// @match        https://dev.rumedia.io/moderation*
// @updateURL    https://raw.githubusercontent.com/shalynwork/rumedia/main/userscripts/rumedia-dev-moderation.user.js
// @downloadURL  https://raw.githubusercontent.com/shalynwork/rumedia/main/userscripts/rumedia-dev-moderation.user.js
// @homepageURL  https://github.com/shalynwork/rumedia
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    /* Сайт — Next.js (серверный рендер, без JSON-API). Очередь фильтруется параметром ?segment=:
       album_pro / album_regular / single_pro / single_regular, по 12 релизов на страницу (page с 1).
       Вместо таблицы показываем саму страницу каждого релиза во встроенной рамке (тот же сайт, поэтому
       дизайн родной и все кнопки — одобрить, нарушения, клише, плеер — работают как есть). */

    const SEGMENTS = {
        album: { label: 'Альбомы', pro: 'album_pro', regular: 'album_regular' },
        single: { label: 'Синглы', pro: 'single_pro', regular: 'single_regular' },
    };
    const PAGE_SIZE = 12;

    // Показываем только ещё не проверенные релизы — статус «Ожидает».
    const isPending = (tr) => /ожидает/i.test(tr.lastElementChild?.textContent || '');

    const STYLE = `
        .rmq-bar { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; flex-wrap:wrap;
            border-bottom:1px solid rgb(188 195 208 / .4); margin-bottom:4px; }
        .rmq-kind { display:flex; gap:24px; }
        .rmq-kind button { position:relative; margin-bottom:-1px; padding:0 0 10px; border:none; background:none; cursor:pointer;
            font:inherit; font-size:16px; font-weight:600; color:#626c77; display:inline-flex; align-items:center; gap:8px; }
        .rmq-kind button:hover { color:#1d2023; }
        .rmq-kind button.is-active { color:#fa40a2; }
        .rmq-kind button.is-active::after { content:''; position:absolute; left:0; right:0; bottom:0; height:2px; border-radius:999px; background:#fa40a2; }
        .rmq-count { display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; padding:0 6px;
            border-radius:999px; background:#f2f3f7; color:#626c77; font-size:11px; font-weight:600; }
        .rmq-kind button.is-active .rmq-count, .rmq-tier button.is-active .rmq-count { background:#fa40a2; color:#fff; }
        .rmq-tier { display:inline-flex; gap:2px; margin-bottom:8px; padding:3px; border-radius:12px; background:#f2f3f7; }
        .rmq-tier button { display:inline-flex; align-items:center; gap:6px; height:30px; padding:0 12px; border:none; border-radius:9px;
            background:transparent; cursor:pointer; font:inherit; font-size:13px; font-weight:500; color:#626c77; }
        .rmq-tier button:hover { color:#1d2023; }
        .rmq-tier button.is-active { background:#fff; color:#1d2023; box-shadow:0 1px 2px rgb(0 0 0 / .08); }
        .rmq-tier .rmq-pro { color:#fa40a2; background:#fbf5f8; border-radius:6px; padding:1px 5px; font-size:10px; font-weight:600; }
        .rmq-hidden { display:none !important; }

        .rmq-list { display:flex; flex-direction:column; gap:12px; margin-top:4px; }
        .rmq-card { position:relative; border:1px solid #eceef3; border-radius:20px; overflow:hidden; background:#fff; }
        .rmq-card iframe { display:block; width:100%; height:640px; border:0; background:#fff; transition:height .15s; }
        .rmq-card.is-loading iframe { visibility:hidden; height:240px; }
        .rmq-skel { position:absolute; inset:0; padding:24px; display:none; flex-direction:column; gap:12px; }
        .rmq-card.is-loading .rmq-skel { display:flex; }
        .rmq-skel i { display:block; height:14px; border-radius:6px; background:#f2f3f7; animation:rmq-pulse 1.6s ease-in-out infinite; }
        .rmq-skel .rmq-skel-head { display:flex; gap:16px; align-items:center; }
        .rmq-skel .rmq-skel-head i:first-child { width:64px; height:64px; border-radius:12px; flex:none; }
        @keyframes rmq-pulse { 50% { opacity:.5; } }
        .rmq-done { display:flex; align-items:center; gap:10px; padding:14px 20px; font-size:14px; color:#626c77; }
        .rmq-done b { color:#1d2023; font-weight:600; }
        .rmq-done a { margin-left:auto; color:#fa40a2; font-size:13px; font-weight:500; text-decoration:none; }
        .rmq-empty { padding:28px 0; text-align:center; font-size:14px; color:#626c77; }
    `;

    // Внутри рамки прячем шапку, меню и «Назад к очереди» — остаётся только содержимое релиза.
    const FRAME_STYLE = `
        html, body { background:#fff !important; min-height:0 !important; height:auto !important; overflow:hidden !important; }
        body > div.fixed.top-0 { display:none !important; }
        main { padding:0 !important; min-height:0 !important; background:#fff !important; display:block !important; }
        main > div.fixed { display:none !important; }
        main > div.rounded-\\[20px\\] { min-height:0 !important; border-radius:0 !important; overflow:visible !important; }
        next-route-announcer { display:none !important; }
    `;

    const qs = (sel, root = document) => root.querySelector(sel);
    const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    function currentSegment() {
        const seg = new URLSearchParams(location.search).get('segment') || 'album_pro';
        const [kind, tier] = seg.split('_');
        return { seg, kind: SEGMENTS[kind] ? kind : 'album', tier: tier === 'regular' ? 'regular' : 'pro' };
    }

    function goSegment(kind, tier) {
        const url = new URL(location.href);
        url.searchParams.set('segment', SEGMENTS[kind][tier]);
        url.searchParams.delete('page');
        location.href = url.toString();
    }

    /* ---------- счётчики сегментов: сколько релизов ждёт в каждом ---------- */

    const countCache = new Map();

    async function countSegment(seg) {
        if (countCache.has(seg)) return countCache.get(seg);
        const job = (async () => {
            let total = 0;
            for (let page = 1; page <= 20; page++) {
                const html = await (await fetch(`/moderation?segment=${seg}&page=${page}`, { credentials: 'include' })).text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const rows = qsa('table tbody tr', doc).filter((tr) => qs('a[href*="/moderation/release/"]', tr));
                total += rows.filter(isPending).length;
                if (rows.length < PAGE_SIZE) break;
            }
            return total;
        })();
        countCache.set(seg, job);
        return job;
    }

    function fillCount(el, seg) {
        countSegment(seg)
            .then((n) => { el.textContent = n; el.hidden = false; })
            .catch(() => el.remove());
    }

    /* ---------- вкладки ---------- */

    function buildBar() {
        const { kind, tier } = currentSegment();
        const bar = document.createElement('div');
        bar.className = 'rmq-bar';
        bar.innerHTML = `
            <div class="rmq-kind" role="tablist">
                ${Object.entries(SEGMENTS).map(([k, s]) => `
                    <button type="button" role="tab" data-kind="${k}" class="${k === kind ? 'is-active' : ''}">
                        ${s.label}<span class="rmq-count" data-count-kind="${k}" hidden></span>
                    </button>`).join('')}
            </div>
            <div class="rmq-tier" role="tablist">
                <button type="button" data-tier="pro" class="${tier === 'pro' ? 'is-active' : ''}"><span class="rmq-pro">PRO</span>PRO-пользователи<span class="rmq-count" data-count-tier="pro" hidden></span></button>
                <button type="button" data-tier="regular" class="${tier === 'regular' ? 'is-active' : ''}">Обычные<span class="rmq-count" data-count-tier="regular" hidden></span></button>
            </div>`;
        bar.addEventListener('click', (e) => {
            const k = e.target.closest('[data-kind]')?.dataset.kind;
            const t = e.target.closest('[data-tier]')?.dataset.tier;
            if (k && k !== kind) goSegment(k, tier);
            if (t && t !== tier) goSegment(kind, t);
        });

        // Альбомы/Синглы — сумма PRO+обычных; PRO/Обычные — внутри выбранного типа.
        qsa('[data-count-kind]', bar).forEach((el) => {
            const s = SEGMENTS[el.dataset.countKind];
            Promise.all([countSegment(s.pro), countSegment(s.regular)])
                .then(([a, b]) => { el.textContent = a + b; el.hidden = false; })
                .catch(() => el.remove());
        });
        qsa('[data-count-tier]', bar).forEach((el) => fillCount(el, SEGMENTS[kind][el.dataset.countTier]));
        return bar;
    }

    /* ---------- карточки релизов во встроенных рамках ---------- */

    const SKELETON = `<div class="rmq-skel"><div class="rmq-skel-head"><i></i><div style="flex:1;display:flex;flex-direction:column;gap:10px"><i style="width:40%"></i><i style="width:25%"></i></div></div>
        <i style="width:100%;height:120px;border-radius:14px"></i><i style="width:70%"></i><i style="width:55%"></i></div>`;

    function frameHrefOf(row) {
        return qs('a[href*="/moderation/release/"]', row)?.getAttribute('href') || '';
    }

    function releasePathOf(href) {
        return (href.match(/\/moderation\/release\/[^/?#]+/) || [])[0] || '';
    }

    function setupFrame(card, iframe, href) {
        const releasePath = releasePathOf(href);
        let lastPath = '';

        const resize = () => {
            const doc = iframe.contentDocument;
            if (!doc?.body) return;
            const content = qs('main > div.rounded-\\[20px\\]', doc) || doc.body;
            const h = Math.ceil(content.getBoundingClientRect().height);
            if (h > 60) iframe.style.height = `${h}px`;
        };

        const markDone = (path) => {
            if (card.dataset.done) return;
            card.dataset.done = '1';
            card.innerHTML = `<div class="rmq-done"><span>✓</span><span><b>Релиз обработан</b> — страница релиза закрылась (решение принято).</span>
                <a href="${releasePath}" target="_blank" rel="noopener">Открыть релиз ↗</a></div>`;
            countCache.clear();
            refreshCounts();
            void path;
        };

        const onLoad = () => {
            const doc = iframe.contentDocument;
            const win = iframe.contentWindow;
            if (!doc || !win) return;
            if (!win.location.pathname.startsWith(releasePath)) return markDone(win.location.pathname);

            if (!qs('#rmq-frame-style', doc)) {
                const st = doc.createElement('style');
                st.id = 'rmq-frame-style';
                st.textContent = FRAME_STYLE;
                doc.head.appendChild(st);
            }
            // «Назад к очереди» в рамке не нужна
            qsa('a', doc).forEach((a) => { if (/Назад к очереди/.test(a.textContent)) a.style.display = 'none'; });

            // Ссылки, ведущие с релиза (артист, владелец и т.п.) — в новой вкладке, а не внутри рамки.
            if (!doc.documentElement.dataset.rmqLinks) {
                doc.documentElement.dataset.rmqLinks = '1';
                doc.addEventListener('click', (e) => {
                    const a = e.target.closest?.('a[href]');
                    if (!a) return;
                    const url = new URL(a.getAttribute('href'), win.location.href);
                    if (url.origin === location.origin && url.pathname.startsWith(releasePath)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(url.toString(), '_blank', 'noopener');
                }, true);
            }

            const ro = new win.ResizeObserver(resize);
            ro.observe(doc.body);
            resize();
            setTimeout(resize, 300);
            setTimeout(resize, 1200);
            card.classList.remove('is-loading');

            // Клиентская навигация Next не вызывает load — следим за адресом сами.
            lastPath = win.location.pathname;
            const watch = setInterval(() => {
                if (!card.isConnected) return clearInterval(watch);
                let path = '';
                try { path = iframe.contentWindow.location.pathname; } catch (_) { return; }
                if (path !== lastPath) {
                    lastPath = path;
                    if (!path.startsWith(releasePath)) {
                        clearInterval(watch);
                        markDone(path);
                    }
                }
                // скрытая ссылка «Назад» могла перерисоваться
                qsa('a', iframe.contentDocument).forEach((a) => { if (/Назад к очереди/.test(a.textContent)) a.style.display = 'none'; });
            }, 700);
        };
        iframe.addEventListener('load', onLoad);
    }

    const lazy = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
            if (!en.isIntersecting) return;
            const iframe = qs('iframe', en.target);
            if (iframe && !iframe.src) iframe.src = iframe.dataset.src;
            lazy.unobserve(en.target);
        });
    }, { rootMargin: '1200px 0px' });

    function buildCard(href) {
        const card = document.createElement('div');
        card.className = 'rmq-card is-loading';
        card.dataset.href = href;
        card.innerHTML = `${SKELETON}<iframe title="Релиз" loading="lazy"></iframe>`;
        const iframe = qs('iframe', card);
        iframe.dataset.src = href;
        setupFrame(card, iframe, href);
        lazy.observe(card);
        return card;
    }

    const cardsByHref = new Map();

    function syncCards(table, list) {
        const hrefs = qsa('tbody tr', table).filter(isPending).map(frameHrefOf).filter(Boolean);
        const wanted = new Set(hrefs);
        cardsByHref.forEach((card, href) => {
            if (!wanted.has(href)) {
                card.remove();
                cardsByHref.delete(href);
            }
        });
        hrefs.forEach((href) => {
            if (!cardsByHref.has(href)) cardsByHref.set(href, buildCard(href));
        });
        // переставляем только если порядок отличается от таблицы (иначе лишние изменения DOM)
        const current = qsa(':scope > .rmq-card', list).map((c) => c.dataset.href);
        if (current.join('|') !== hrefs.join('|')) hrefs.forEach((href) => list.appendChild(cardsByHref.get(href)));
        let empty = qs('.rmq-empty', list);
        if (!hrefs.length) {
            if (!empty) {
                empty = document.createElement('div');
                empty.className = 'rmq-empty';
                empty.textContent = 'Нет релизов, ожидающих проверки';
                list.appendChild(empty);
            }
        } else if (empty) {
            empty.remove();
        }
    }

    function refreshCounts() {
        const old = qs('.rmq-bar');
        if (old) old.replaceWith(buildBar());
    }

    /* ---------- сборка страницы очереди ---------- */

    function enhanceQueue() {
        if (location.pathname !== '/moderation') return;
        const table = qs('main table');
        const statusTabs = qsa('main button').find((b) => b.textContent.trim() === 'Все')?.parentElement?.parentElement;
        if (!table || !statusTabs) return;

        if (!qs('#rmq-style')) {
            const st = document.createElement('style');
            st.id = 'rmq-style';
            st.textContent = STYLE;
            document.head.appendChild(st);
        }

        // уже настроено для этой таблицы (React мог пересоздать её при переходе — тогда настроим заново)
        if (table.dataset.rmqObserved && qs('.rmq-list') && qs('.rmq-bar')) return;

        // вкладки статуса и фильтр сайта заменяем своими вкладками (показываем только «Ожидает»)
        statusTabs.classList.add('rmq-hidden');
        qs('.rmq-bar')?.remove();
        statusTabs.before(buildBar());

        // таблицу прячем (React продолжает её обновлять — по ней и строим карточки)
        const tableWrap = table.closest('.overflow-x-auto') || table;
        tableWrap.classList.add('rmq-hidden');
        let list = qs('.rmq-list');
        if (!list) {
            list = document.createElement('div');
            list.className = 'rmq-list';
        }
        if (list.previousElementSibling !== tableWrap) tableWrap.after(list);
        syncCards(table, list);

        table.dataset.rmqObserved = '1';
        new MutationObserver(() => syncCards(table, list)).observe(table, { childList: true, subtree: true, characterData: true });
    }

    // Next.js переходит между страницами без перезагрузки — перепроверяем при изменениях.
    let scheduled = false;
    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            enhanceQueue();
        });
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    enhanceQueue();
})();
