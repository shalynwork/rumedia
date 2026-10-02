// ==UserScript==
// @name         RuMedia Moderation (new site)
// @namespace    https://dev.rumedia.io/
// @version      0.2.1
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
        .rmq-empty .rmq-ghost { margin-left:8px; }
        .rmq-nav { display:flex; align-items:center; justify-content:center; gap:14px; font-size:13px; color:#626c77; }
        .rmq-nav b { color:#1d2023; }
        .rmq-nav-btn { width:32px; height:32px; border:1px solid #d9d9d9; border-radius:10px; background:#fff; cursor:pointer;
            font-size:18px; line-height:1; color:#1d2023; }
        .rmq-nav-btn:hover:not(:disabled) { background:#fbf5f8; color:#fa40a2; }
        .rmq-nav-btn:disabled { opacity:.35; cursor:default; }

        /* окно решения (Отклонить / Запросить права) — в стиле сайта */
        .rmq-overlay { position:fixed; inset:0; z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px;
            background:rgb(29 32 35 / .4); animation:rmq-fade .15s ease; }
        @keyframes rmq-fade { from { opacity:0; } }
        .rmq-modal { width:min(600px, 96vw); max-height:92vh; overflow:auto; background:#fff; border-radius:20px; padding:24px;
            box-shadow:0 20px 50px rgb(29 32 35 / .2); color:#1d2023; font-family:inherit; }
        .rmq-modal h3 { margin:0; font-size:20px; font-weight:600; }
        .rmq-modal .rmq-sub { margin-top:4px; font-size:13px; color:#626c77; }
        .rmq-mode { display:inline-flex; gap:2px; margin:18px 0 14px; padding:3px; border-radius:12px; background:#f2f3f7; }
        .rmq-mode button { height:32px; padding:0 14px; border:none; border-radius:9px; background:transparent; cursor:pointer;
            font:inherit; font-size:13px; font-weight:500; color:#626c77; }
        .rmq-mode button.is-active { background:#fff; color:#1d2023; box-shadow:0 1px 2px rgb(0 0 0 / .08); }
        .rmq-section { border:1px solid rgb(188 195 208 / .5); border-radius:16px; padding:16px; }
        .rmq-section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; }
        .rmq-label { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:#6b1e45; }
        .rmq-ghost { padding:6px 12px; border:1px solid #d9d9d9; border-radius:8px; background:#fff; cursor:pointer;
            font:inherit; font-size:12px; font-weight:500; color:#1d2023; }
        .rmq-ghost:hover, .rmq-ghost.is-open { background:#fbf5f8; }
        .rmq-prefix { padding:10px 14px; border:1px solid #d9d9d9; border-bottom:none; border-radius:12px 12px 0 0;
            background:#fbf5f8; font-size:13px; line-height:1.45; color:#626c77; }
        .rmq-modal textarea { display:block; width:100%; min-height:130px; box-sizing:border-box; resize:vertical; padding:12px 16px;
            border:1px solid #d9d9d9; border-radius:0 0 12px 12px; outline:none; font:inherit; font-size:14px; line-height:1.5; color:#1e1e1e; }
        .rmq-modal textarea:focus { border-color:#fa40a2; }
        .rmq-foot { display:flex; align-items:center; justify-content:flex-end; gap:10px; margin-top:18px; }
        .rmq-status { margin-right:auto; font-size:13px; color:#626c77; }
        .rmq-status.is-warn { color:#b7791f; }
        .rmq-btn { padding:10px 20px; border:1px solid transparent; border-radius:12px; cursor:pointer; font:inherit; font-size:14px; font-weight:500; }
        .rmq-btn--cancel { background:#fff; border-color:#d9d9d9; color:#1d2023; }
        .rmq-btn--reject { background:#d64545; color:#fff; }
        .rmq-btn--rights { background:#e5922b; color:#fff; }
        .rmq-btn:hover { opacity:.9; }

        /* клише */
        .rmq-cl { margin-bottom:12px; border:1px solid #d9d9d9; border-radius:12px; overflow:hidden; }
        .rmq-cl[hidden] { display:none; }
        .rmq-cl-top { display:flex; align-items:center; gap:8px; padding-right:12px; border-bottom:1px solid #f2f3f7; }
        .rmq-cl-search { flex:1; min-width:0; height:40px; padding:0 14px; border:none; outline:none; font:inherit; font-size:14px; }
        .rmq-cl-manage { font-size:12px; font-weight:500; color:#fa40a2; text-decoration:none; white-space:nowrap; }
        .rmq-cl-list { max-height:240px; overflow:auto; }
        .rmq-cl-item { display:flex; align-items:flex-start; gap:10px; width:100%; padding:10px 14px; border:none; border-top:1px solid #f2f3f7;
            background:#fff; text-align:left; font:inherit; cursor:pointer; }
        .rmq-cl-item:first-child { border-top:none; }
        .rmq-cl-item:hover { background:#fbf5f8; }
        .rmq-cl-item.is-picked { background:#fbf5f8; }
        .rmq-cl-mark { flex:none; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; margin-top:1px;
            border:1.5px solid #bcc3d0; border-radius:50%; font-size:11px; font-weight:700; color:#fff; }
        .rmq-cl-item.is-picked .rmq-cl-mark { background:#fa40a2; border-color:#fa40a2; }
        .rmq-cl-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
        .rmq-cl-text b { font-size:13.5px; font-weight:600; color:#1d2023; }
        .rmq-cl-text span { font-size:12.5px; color:#626c77; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .rmq-cl-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 14px;
            border-top:1px solid #f2f3f7; background:#fafafb; font-size:12.5px; color:#626c77; }
        .rmq-cl-insert { padding:6px 14px; border:none; border-radius:8px; background:#fa40a2; color:#fff; font:inherit; font-size:13px;
            font-weight:500; cursor:pointer; }
        .rmq-cl-insert:disabled { opacity:.4; cursor:default; }
        .rmq-cl-empty { padding:16px 14px; font-size:13px; color:#626c77; }
    `;

    // Внутри рамки прячем шапку, меню и «Назад к очереди» — остаётся только содержимое релиза.
    const FRAME_STYLE = `
        html, body { background:#fff !important; min-height:0 !important; height:auto !important; overflow:hidden !important; }
        body > div.fixed.top-0 { display:none !important; }
        main { padding:0 !important; min-height:0 !important; background:#fff !important; display:block !important; }
        main > div.fixed { display:none !important; }
        main > div.rounded-\\[20px\\]:not(.fixed) { min-height:0 !important; border-radius:0 !important; overflow:visible !important; }
        next-route-announcer { display:none !important; }
        .rmq-x { display:none !important; }
        .rmq-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:12px; }
        .rmq-act { padding:10px 20px; border:1px solid transparent; border-radius:12px; cursor:pointer; font:inherit; font-size:14px; font-weight:500; }
        .rmq-act--reject { background:#fff; border-color:#f3c4c4; color:#d64545; }
        .rmq-act--reject:hover { background:#fdecec; }
        .rmq-act--rights { background:#fff; border-color:#f6d9a8; color:#b7791f; }
        .rmq-act--rights:hover { background:#fff7e6; }
        .rmq-act--approve { background:#2fb26b; color:#fff; }
        .rmq-act--approve:hover { opacity:.9; }
        section.rmq-hist { position:relative; }
        .rmq-hist-label-closed { margin-bottom:0 !important; }
        .rmq-hist-toggle { position:absolute; top:12px; right:12px; padding:4px 10px; border:1px solid #d9d9d9; border-radius:8px;
            background:#fff; cursor:pointer; font:inherit; font-size:12px; font-weight:500; color:#1d2023; }
        .rmq-hist-toggle:hover { background:#fbf5f8; }
    `;

    // Что убираем из карточки релиза (по подписям-заголовкам блоков сайта).
    const HIDE_SECTIONS = ['нарушения', 'добавить заметку'];            // целые блоки
    const HIDE_SUBSECTIONS = ['статистика', 'отправитель', 'техническое']; // подразделы метаданных и треков

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

    const labelOf = (el) => (el?.textContent || '').trim().toLowerCase();

    // Приводим страницу релиза в рамке к нужному виду. Вызывается при загрузке и после каждой перерисовки React.
    function tidyFrame(doc, ctx) {
        const content = qs('main > div.rounded-\\[20px\\]:not(.fixed)', doc);
        if (!content) return;

        // ID релиза
        qsa('p', content).forEach((p) => {
            if (!p.children.length && /^ID\s+[0-9a-f-]{20,}/i.test(p.textContent.trim())) p.classList.add('rmq-x');
        });

        // заголовки блоков (p.mini-label) и подразделов метаданных/треков (p.uppercase)
        qsa('p.mini-label, p.uppercase', content).forEach((label) => {
            const name = labelOf(label);
            // целые блоки: «Нарушения», «Добавить заметку» (заметка и клише — в нашем окне)
            if (HIDE_SECTIONS.includes(name)) label.closest('section')?.classList.add('rmq-x');
            // подразделы: «Статистика», «Отправитель», «Техническое» (у каждого трека)
            if (HIDE_SUBSECTIONS.includes(name)) label.closest('div.border-t, section')?.classList.add('rmq-x');
            // «История модерации» — свёрнута, раскрывается по кнопке
            if (name === 'история модерации') collapseHistory(doc, label);
        });

        // панель решения сайта («Нарушений не отмечено… / Одобрить») → наши две кнопки
        // («Отклонить / Запросить права» открывает окно, режим переключается внутри)
        const approve = qsa('button', content).find((b) => b.textContent.trim() === 'Одобрить' && !b.closest('.rmq-actions'));
        const siteBar = approve?.parentElement;
        if (siteBar && !siteBar.classList.contains('rmq-x')) {
            siteBar.classList.add('rmq-x');
        }
        if (siteBar && !qs('.rmq-actions', content)) {
            const bar = doc.createElement('div');
            bar.className = 'rmq-actions';
            bar.innerHTML = `
                <button type="button" class="rmq-act rmq-act--reject" data-act="reject">Отклонить / Запросить права</button>
                <button type="button" class="rmq-act rmq-act--approve" data-act="approve">Одобрить</button>`;
            bar.addEventListener('click', (e) => {
                const act = e.target.closest('[data-act]')?.dataset.act;
                if (!act) return;
                if (act === 'approve') {
                    // настоящая кнопка сайта (спрятана) — её и нажимаем
                    const real = qsa('button', content).find((b) => b.textContent.trim() === 'Одобрить' && !b.closest('.rmq-actions'));
                    real?.click();
                    return;
                }
                openDecisionModal(act, releaseInfoOf(doc, ctx));
            });
            siteBar.after(bar);
        }
    }

    // «История модерации» свёрнута: прячем всё, кроме заголовка (узлы React не переносим — только классы),
    // кнопка «Показать (N)» в правом верхнем углу блока. Состояние живёт на самом блоке.
    function collapseHistory(doc, label) {
        const section = label.closest('section');
        if (!section) return;
        const open = section.dataset.rmqOpen === '1';
        Array.from(section.children).forEach((el) => {
            if (el !== label && !el.classList.contains('rmq-hist-toggle')) el.classList.toggle('rmq-x', !open);
        });
        let btn = qs(':scope > .rmq-hist-toggle', section);
        if (!btn) {
            btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'rmq-hist-toggle';
            btn.addEventListener('click', () => {
                section.dataset.rmqOpen = section.dataset.rmqOpen === '1' ? '' : '1';
                collapseHistory(doc, label);
            });
            section.appendChild(btn);
        }
        const rows = qsa('tbody tr', section).length;
        btn.textContent = open ? 'Свернуть' : `Показать${rows ? ` (${rows})` : ''}`;
        section.classList.add('rmq-hist');
        label.classList.toggle('rmq-hist-label-closed', !open);
    }

    function releaseInfoOf(doc, ctx) {
        const content = qs('main > div.rounded-\\[20px\\]:not(.fixed)', doc);
        const title = (qs('h1', content)?.textContent || '').trim();
        // владелец — ссылка на пользователя без звёздочки рейтинга
        const owner = qsa('a[href*="/moderation/users/"]', content).find((a) => !/★/.test(a.textContent))?.textContent.trim() || '';
        const kind = /single/.test(ctx.href) ? 'single' : 'album';
        return { title, owner, kind };
    }

    function setupFrame(card, iframe, href) {
        const releasePath = releasePathOf(href);
        let lastPath = '';

        const resize = () => {
            const doc = iframe.contentDocument;
            if (!doc?.body) return;
            // у бокового меню тоже rounded-[20px], но оно fixed — берём содержимое
            const content = qs('main > div.rounded-\\[20px\\]:not(.fixed)', doc) || doc.body;
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
            doneHrefs.add(href);
            // через секунду — следующий релиз (индекс тот же: обработанный выпал из списка)
            setTimeout(() => {
                card.remove();
                cardsByHref.delete(href);
                if (lastTable && lastList) syncCards(lastTable, lastList);
            }, 1200);
        };

        const onLoad = () => {
            const doc = iframe.contentDocument;
            const win = iframe.contentWindow;
            // пустая рамка (about:blank) до установки src тоже шлёт load — её пропускаем
            if (!doc || !win || !iframe.getAttribute('src') || win.location.href === 'about:blank') return;
            if (!win.location.pathname.startsWith(releasePath)) return markDone(win.location.pathname);

            if (!qs('#rmq-frame-style', doc)) {
                const st = doc.createElement('style');
                st.id = 'rmq-frame-style';
                st.textContent = FRAME_STYLE;
                doc.head.appendChild(st);
            }
            // «Назад к очереди» в рамке не нужна
            qsa('a', doc).forEach((a) => { if (/Назад к очереди/.test(a.textContent)) a.style.display = 'none'; });

            // убрать лишнее, свернуть историю, поставить свои кнопки — и повторять после перерисовок React
            const ctx = { href };
            tidyFrame(doc, ctx);
            let tidyQueued = false;
            new win.MutationObserver(() => {
                if (tidyQueued) return;
                tidyQueued = true;
                // таймер, а не requestAnimationFrame: тот не срабатывает, пока вкладка в фоне
                win.setTimeout(() => {
                    tidyQueued = false;
                    tidyFrame(doc, ctx);
                }, 30);
            }).observe(doc.body, { childList: true, subtree: true });

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

            card._rmqResize = resize;
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

    // Очередь загрузки рамок: сверху вниз, по 2 одновременно — первый релиз виден быстрее,
    // и сервер не получает 12 тяжёлых страниц разом. (Не зависим от видимости вкладки.)
    const LOAD_PARALLEL = 2;
    let loadingNow = 0;
    const loadQueue = [];

    function pumpLoads() {
        // порядок загрузки — как карточки на странице (сортируем здесь: при постановке в очередь карточки ещё не в DOM)
        loadQueue.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        while (loadingNow < LOAD_PARALLEL && loadQueue.length) {
            const iframe = loadQueue.shift();
            if (!iframe.isConnected || iframe.getAttribute('src')) continue;
            loadingNow++;
            let finished = false;
            const done = () => {
                if (finished) return;
                finished = true;
                loadingNow--;
                pumpLoads();
            };
            iframe.addEventListener('load', done, { once: true });
            setTimeout(done, 20000); // не ждём вечно зависшую страницу
            iframe.setAttribute('src', iframe.dataset.src);
        }
    }

    function queueLoad(iframe) {
        loadQueue.push(iframe);
        setTimeout(pumpLoads, 0);
    }

    function buildCard(href) {
        const card = document.createElement('div');
        card.className = 'rmq-card is-loading';
        card.dataset.href = href;
        card.innerHTML = `${SKELETON}<iframe title="Релиз"></iframe>`;
        const iframe = qs('iframe', card);
        iframe.dataset.src = href;
        setupFrame(card, iframe, href);
        queueLoad(iframe);
        return card;
    }

    // На странице — один релиз (как на старом сайте): «Релиз 2 из 6» и стрелки ‹ ›.
    // Грузим текущий и заранее следующий. После решения — сразу следующий.
    const cardsByHref = new Map();
    const doneHrefs = new Set();
    let viewIndex = 0;
    let lastTable = null;
    let lastList = null;

    function pendingHrefs(table) {
        return qsa('tbody tr', table).filter(isPending).map(frameHrefOf).filter((h) => h && !doneHrefs.has(h));
    }

    function siteHasNextPage(table) {
        return qsa('tbody tr', table).length >= PAGE_SIZE;
    }

    function goPage(delta) {
        const url = new URL(location.href);
        const page = Math.max(1, Number(url.searchParams.get('page') || 1) + delta);
        url.searchParams.set('page', String(page));
        location.href = url.toString();
    }

    function ensureCard(href) {
        if (!cardsByHref.has(href)) cardsByHref.set(href, buildCard(href));
        return cardsByHref.get(href);
    }

    function syncCards(table, list) {
        lastTable = table;
        lastList = list;
        const hrefs = pendingHrefs(table);
        const page = Number(new URL(location.href).searchParams.get('page') || 1);

        // карточки ушедших из таблицы релизов убираем
        cardsByHref.forEach((card, href) => {
            if (!hrefs.includes(href) && !card.dataset.done) {
                card.remove();
                cardsByHref.delete(href);
            }
        });

        let nav = qs(':scope > .rmq-nav', list);
        let empty = qs(':scope > .rmq-empty', list);
        if (!hrefs.length) {
            nav?.remove();
            cardsByHref.forEach((card) => { if (!card.dataset.done) card.classList.add('rmq-hidden'); });
            if (!empty) {
                empty = document.createElement('div');
                empty.className = 'rmq-empty';
                list.appendChild(empty);
            }
            empty.innerHTML = siteHasNextPage(table)
                ? 'На этой странице всё проверено. <button type="button" class="rmq-ghost" data-page="1">Следующая страница →</button>'
                : 'Нет релизов, ожидающих проверки';
            qs('[data-page]', empty)?.addEventListener('click', () => goPage(1));
            return;
        }
        empty?.remove();

        viewIndex = Math.min(Math.max(0, viewIndex), hrefs.length - 1);
        const current = hrefs[viewIndex];

        if (!nav) {
            nav = document.createElement('div');
            nav.className = 'rmq-nav';
            nav.addEventListener('click', (e) => {
                const d = Number(e.target.closest('[data-step]')?.dataset.step || 0);
                if (!d) return;
                const all = pendingHrefs(lastTable);
                if (viewIndex + d >= all.length && siteHasNextPage(lastTable)) return goPage(1);
                if (viewIndex + d < 0 && page > 1) return goPage(-1);
                viewIndex = Math.min(Math.max(0, viewIndex + d), all.length - 1);
                syncCards(lastTable, lastList);
                window.scrollTo({ top: list.getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
            });
            list.prepend(nav);
        }
        const canPrev = viewIndex > 0 || page > 1;
        const canNext = viewIndex < hrefs.length - 1 || siteHasNextPage(table);
        nav.innerHTML = `
            <button type="button" class="rmq-nav-btn" data-step="-1" ${canPrev ? '' : 'disabled'} aria-label="Предыдущий релиз">‹</button>
            <span>Релиз <b>${viewIndex + 1}</b> из ${hrefs.length}${page > 1 ? ` · стр. ${page}` : ''}</span>
            <button type="button" class="rmq-nav-btn" data-step="1" ${canNext ? '' : 'disabled'} aria-label="Следующий релиз">›</button>`;

        // показываем только текущий; следующий грузится заранее (скрыт)
        const show = ensureCard(current);
        const next = hrefs[viewIndex + 1];
        if (next) ensureCard(next);
        cardsByHref.forEach((card, href) => {
            const visible = href === current;
            card.classList.toggle('rmq-hidden', !visible);
            if (!card.isConnected) list.appendChild(card);
        });
        if (show.previousElementSibling !== nav) nav.after(show);
        show._rmqResize?.();
    }

    function refreshCounts() {
        const old = qs('.rmq-bar');
        if (old) old.replaceWith(buildBar());
    }

    /* ---------- окно «Отклонить / Запросить права»: заметка + клише ----------
       Пока ПРИМЕР: решение не отправляется (отклонение на новом сайте ещё не подключено). */

    const CLISHE_API = 'https://shalyn.work/pastes/get_pastes.php';
    const CLISHE_MANAGE_URL = 'https://shalyn.work/pastes/manage/';
    let clisheCache = null;

    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    async function loadClishe(force = false) {
        if (!force && clisheCache && Date.now() - clisheCache.at < 5 * 60 * 1000) return clisheCache.items;
        const res = await fetch(CLISHE_API, { cache: 'no-store' });
        if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
        const data = await res.json();
        const toText = (html) => (new DOMParser().parseFromString(String(html || '').replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent || '').trim();
        const items = (Array.isArray(data) ? data : [])
            .map((p) => ({ id: String(p.id), name: String(p.name || '').trim() || 'Без названия', text: toText(p.content) }))
            .filter((p) => p.text);
        clisheCache = { at: Date.now(), items };
        return items;
    }

    const TEMPLATES = {
        reject: (info) => `${info.owner ? `@${info.owner} ` : ''}К сожалению, ваш релиз был отклонен. Причина:`,
        rights: (info) => `${info.owner ? `@${info.owner}. ` : ''}Подскажите, пожалуйста, есть ли у вас права на использование инструментала в загруженном ${info.kind === 'album' ? 'альбоме' : 'треке'} "${info.title}"? ` +
            'Доказательством наличия прав может являться договор с битмейкером, либо небольшое видео с проектом в секвенсоре. ' +
            'Вы можете направить информацию в чат, после чего релиз отправится на площадки.',
    };

    function openDecisionModal(mode, info) {
        qs('.rmq-overlay')?.remove();
        const texts = { reject: '', rights: TEMPLATES.rights(info) };
        const overlay = document.createElement('div');
        overlay.className = 'rmq-overlay';
        overlay.innerHTML = `
            <div class="rmq-modal" role="dialog" aria-modal="true">
                <h3>Решение по релизу</h3>
                <div class="rmq-sub">${esc(info.title || '—')}${info.owner ? ` · ${esc(info.owner)}` : ''}</div>
                <div class="rmq-mode">
                    <button type="button" data-mode="reject">Отклонить</button>
                    <button type="button" data-mode="rights">Запросить права</button>
                </div>
                <div class="rmq-section">
                    <div class="rmq-section-head">
                        <span class="rmq-label">Добавить заметку</span>
                        <button type="button" class="rmq-ghost rmq-cl-toggle">Клише</button>
                    </div>
                    <div class="rmq-cl" hidden>
                        <div class="rmq-cl-top">
                            <input type="text" class="rmq-cl-search" placeholder="Поиск клише…">
                            <a class="rmq-cl-manage" href="${CLISHE_MANAGE_URL}" target="_blank" rel="noopener">Добавить / изменить ↗</a>
                        </div>
                        <div class="rmq-cl-list"></div>
                        <div class="rmq-cl-foot"><span class="rmq-cl-count"></span><button type="button" class="rmq-cl-insert" disabled>Вставить</button></div>
                    </div>
                    <div class="rmq-prefix"></div>
                    <textarea placeholder="Причина отклонения…"></textarea>
                </div>
                <div class="rmq-foot">
                    <span class="rmq-status"></span>
                    <button type="button" class="rmq-btn rmq-btn--cancel">Отмена</button>
                    <button type="button" class="rmq-btn rmq-btn--primary"></button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const ta = qs('textarea', overlay);
        const prefix = qs('.rmq-prefix', overlay);
        const primary = qs('.rmq-btn--primary', overlay);
        const status = qs('.rmq-status', overlay);
        let current = mode;

        const setMode = (m) => {
            texts[current] = ta.value;
            current = m;
            qsa('.rmq-mode button', overlay).forEach((b) => b.classList.toggle('is-active', b.dataset.mode === m));
            prefix.textContent = m === 'reject' ? TEMPLATES.reject(info) : '';
            prefix.hidden = m !== 'reject';
            ta.style.borderRadius = m === 'reject' ? '' : '12px';
            ta.value = texts[m];
            ta.placeholder = m === 'reject' ? 'Причина отклонения…' : 'Текст запроса прав';
            primary.textContent = m === 'reject' ? 'Отклонить релиз' : 'Отправить запрос';
            primary.className = `rmq-btn rmq-btn--primary ${m === 'reject' ? 'rmq-btn--reject' : 'rmq-btn--rights'}`;
            status.textContent = '';
            status.className = 'rmq-status';
        };
        qs('.rmq-mode', overlay).addEventListener('click', (e) => {
            const m = e.target.closest('[data-mode]')?.dataset.mode;
            if (m && m !== current) setMode(m);
        });

        const close = () => {
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
        };
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            const panel = qs('.rmq-cl', overlay);
            if (!panel.hidden) { panel.hidden = true; qs('.rmq-cl-toggle', overlay).classList.remove('is-open'); }
            else close();
        };
        document.addEventListener('keydown', onKey, true);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        qs('.rmq-btn--cancel', overlay).addEventListener('click', close);

        primary.addEventListener('click', () => {
            if (!ta.value.trim()) {
                status.textContent = current === 'reject' ? 'Напишите причину отклонения' : 'Напишите текст запроса';
                status.className = 'rmq-status is-warn';
                ta.focus();
                return;
            }
            // ПРИМЕР: отправку на новом сайте ещё не подключали
            status.textContent = 'Пример: решение не отправлено — отклонение пока не подключено';
            status.className = 'rmq-status is-warn';
        });

        bindClishe(overlay, (block) => {
            const cur = ta.value.replace(/\s+$/, '');
            ta.value = cur ? `${cur}\n\n${block}` : block;
            ta.focus();
        });
        setMode(mode);
        ta.focus();
    }

    function bindClishe(root, onInsert) {
        const box = qs('.rmq-cl', root);
        const toggle = qs('.rmq-cl-toggle', root);
        const search = qs('.rmq-cl-search', root);
        const list = qs('.rmq-cl-list', root);
        const count = qs('.rmq-cl-count', root);
        const insert = qs('.rmq-cl-insert', root);
        let items = null;
        const picked = [];

        const render = () => {
            if (!items) return;
            const q = search.value.trim().toLowerCase();
            const shown = items.filter((p) => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
            list.innerHTML = shown.length
                ? shown.map((p) => {
                    const n = picked.indexOf(p.id);
                    return `<button type="button" class="rmq-cl-item${n >= 0 ? ' is-picked' : ''}" data-id="${esc(p.id)}">
                        <span class="rmq-cl-mark">${n >= 0 ? n + 1 : ''}</span>
                        <span class="rmq-cl-text"><b>${esc(p.name)}</b><span>${esc(p.text.replace(/\s+/g, ' '))}</span></span></button>`;
                }).join('')
                : `<div class="rmq-cl-empty">${items.length ? 'Ничего не найдено' : 'Клише пока нет'}</div>`;
            count.textContent = picked.length ? `Выбрано: ${picked.length}${picked.length > 1 ? ' — вставятся списком' : ''}` : 'Нажмите на клише, чтобы выбрать';
            insert.disabled = !picked.length;
        };
        const load = async (force) => {
            list.innerHTML = '<div class="rmq-cl-empty">Загружаю клише…</div>';
            try {
                items = await loadClishe(force);
                render();
            } catch (err) {
                list.innerHTML = `<div class="rmq-cl-empty">Не удалось загрузить клише: ${esc(err.message || err)}</div>`;
            }
        };
        toggle.addEventListener('click', () => {
            box.hidden = !box.hidden;
            toggle.classList.toggle('is-open', !box.hidden);
            if (!box.hidden) {
                search.focus();
                if (!items) load(false);
            }
        });
        search.addEventListener('input', render);
        list.addEventListener('click', (e) => {
            const id = e.target.closest('.rmq-cl-item')?.dataset.id;
            if (!id) return;
            const i = picked.indexOf(id);
            if (i >= 0) picked.splice(i, 1);
            else picked.push(id);
            render();
        });
        insert.addEventListener('click', () => {
            const chosen = picked.map((id) => items.find((p) => p.id === id)).filter(Boolean);
            if (!chosen.length) return;
            onInsert(chosen.length > 1 ? chosen.map((p, i) => `${i + 1}. ${p.text}`).join('\n\n') : chosen[0].text);
            picked.length = 0;
            search.value = '';
            box.hidden = true;
            toggle.classList.remove('is-open');
            render();
        });
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
        // пагинация сайта («Результатов на странице… 1–12 из 16») — у нас своя «Релиз N из M»
        const isPager = (d) => /Результатов на странице/.test(d.textContent) && /\d+\s*–\s*\d+\s*из\s*\d+/.test(d.textContent) && d.textContent.length < 200;
        qsa('main div').filter(isPager).filter((d) => !qsa('div', d).some(isPager)).forEach((d) => d.classList.add('rmq-hidden'));
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
        setTimeout(() => {
            scheduled = false;
            enhanceQueue();
        }, 30);
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    enhanceQueue();
})();
