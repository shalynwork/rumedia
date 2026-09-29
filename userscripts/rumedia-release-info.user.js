// ==UserScript==
// @name         RuMedia Release Details Helper + Album Authors
// @namespace    https://rumedia.io/
// @version      8.6.0
// @updateURL    https://raw.githubusercontent.com/shalynwork/rumedia/main/userscripts/rumedia-release-info.user.js
// @downloadURL  https://raw.githubusercontent.com/shalynwork/rumedia/main/userscripts/rumedia-release-info.user.js
// @homepageURL  https://github.com/shalynwork/rumedia
// @description  Подробности релиза + комментарии + Мат + инфо об альбоме (артисты/автор/дата/треки/ИИ) в списке + загрузка/повтор + скрытие кнопки Звонко на синглах + увеличение обложек + автор/продюсер в edit-album + иконка текста песни и AI-анализ на запрещённый контент (с онлайн-кешем) на RuMedia.io.
// @author       Ruslan
// @match        https://rumedia.io/media/admin-cp/manage-songs?check*
// @match        https://rumedia.io/media/admin-cp/manage-albums?check*
// @match        https://rumedia.io/media/edit-album/*
// @grant        none
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const STATE = {
        cache: new Map(),
        commentsCache: new Map(),
        authorsCache: new Map(),
        analysisCache: new Map(),
        aiArtworkCache: new Map(),
    };

    // Бэкенд AI-анализа (PHP на твоём хостинге). ВПИШИ свой URL и тот же токен,
    // что стоит в analyze.php ($CONFIG['token']).
    const ANALYZE_ENDPOINT = 'https://shalyn.work/rumedia/analyze.php';
    const ANALYZE_TOKEN = 'lilsifmerccifuul20234';

    const MODERATOR_NAMES = {
        moderator3: 'Руслан',
        moderator7: 'Матвей',
        moderator: 'Илья',
        f4zersed: 'Платон',
        yphomerc: 'Илья (чат)',
    };

    const NET = {
        timeoutMs: 30000,
        retries: 1,
    };

    // Комментарии: если их больше COMMENTS_COLLAPSE_OVER, видны только COMMENTS_VISIBLE самых свежих.
    const COMMENTS_COLLAPSE_OVER = 5;
    const COMMENTS_VISIBLE = 2;

    /* =====================================================
                        ПАРСИНГ ДЕТАЛЕЙ
    ===================================================== */

    function parseDetails(htmlText) {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');

        const producer = doc.querySelector('input#producer')?.value?.trim() || '—';
        const written = doc.querySelector('input#written')?.value?.trim() || '—';
        const vocal = doc.querySelector('select#vocal option:checked')?.textContent?.trim() || '—';
        const lyrics = doc.querySelector('textarea#text_lyrics')?.value?.trim() || '';
        const aiComment = doc.querySelector('textarea#ai_moderation_comment')?.value?.trim() || '';

        let age = '—';
        const ageSelect = doc.querySelector('select#age_restriction');
        if (ageSelect) age = ageSelect.value === '1' ? '18+' : '0+';

        const aiEl = doc.querySelector('input[name="is_ai_artwork"]');
        const aiArtwork = aiEl ? aiEl.hasAttribute('checked') : null;

        const releaseDate = doc.querySelector('input#tags')?.value?.trim() || '';
        const apple = parseAppleDelivery(doc);
        const artistList = parseArtistList(doc);

        return { producer, written, vocal, age, lyrics, aiComment, aiArtwork, releaseDate, apple, artistList };
    }

    // Список артистов со страницы редактирования: [{ name, feat }]. feat — включён переключатель «feat.».
    function parseArtistList(doc) {
        return Array.from(doc.querySelectorAll('#artists_list li.playlist-list-song'))
            .map((li) => {
                const name = (li.querySelector('#artist_naming, .art_details h4')?.textContent || '').trim();
                const box = li.querySelector('.check input[type="checkbox"]');
                const feat =
                    (box ? box.hasAttribute('checked') : false) ||
                    /feat/i.test(li.querySelector('.duration')?.textContent || '');
                return { name, feat };
            })
            .filter((a) => a.name);
    }

    // «Доставка на площадки» → галочка Apple. null — если блока на странице нет.
    function parseAppleDelivery(doc) {
        const el = doc.querySelector('input[type="checkbox"][name="apple"]');
        return el ? el.hasAttribute('checked') : null;
    }

    function parseAiArtwork(htmlText) {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');
        const el = doc.querySelector('input[name="is_ai_artwork"]');
        return { aiUsed: el ? el.hasAttribute('checked') : null };
    }

    function parseAlbumInfo(htmlText) {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');

        const aiEl = doc.querySelector('input[name="is_ai_artwork"]');
        const aiUsed = aiEl ? aiEl.hasAttribute('checked') : null;

        const artists =
            doc.querySelector('input#artists')?.value?.trim() ||
            Array.from(doc.querySelectorAll('#artists_list #artist_naming'))
                .map((h) => h.textContent.trim())
                .filter(Boolean)
                .join(', ') ||
            '';

        const written = doc.querySelector('input#written')?.value?.trim() || '';
        const releaseDate = doc.querySelector('input#description')?.value?.trim() || '';
        const apple = parseAppleDelivery(doc);
        const artistList = parseArtistList(doc);
        const tracks = parseTrackBlocks(doc);
        const trackCount = tracks.length || doc.querySelectorAll('#songs .uploaded_albm_slist').length || null;

        return { aiUsed, artists, artistList, written, releaseDate, apple, trackCount, tracks };
    }

    function parseTrackBlocks(doc) {
        return Array.from(doc.querySelectorAll('#songs .uploaded_albm_slist'))
            .map((block) => {
                const p = block.querySelector('p');
                const link = block.querySelector('a[href*="edit-track"]');
                const id = link
                    ? link.getAttribute('href').match(/edit-track\/([A-Za-z0-9]+)/)?.[1] || null
                    : null;

                let title = '';
                if (p) {
                    const firstText = Array.from(p.childNodes).find(
                        (n) => n.nodeType === 3 && n.textContent.trim()
                    );
                    title = firstText
                        ? firstText.textContent.trim()
                        : (p.textContent.split('|')[0] || '').trim();
                }

                let explicit = '';
                const exSpan = p?.querySelector('span');
                if (exSpan) explicit = exSpan.textContent.replace(/^[\s|]+/, '').trim();

                let vocalInfo = '';
                let warning = '';
                block.querySelectorAll('span').forEach((s) => {
                    const t = s.textContent.trim();
                    if (!vocalInfo && t.startsWith('Вокал')) vocalInfo = t.replace(/\s+/g, ' ');
                    const style = s.getAttribute('style') || '';
                    if (/color:\s*red/i.test(style) && t) warning = t;
                });

                const audioSrc = block.querySelector('audio source')?.getAttribute('src') || '';

                return { id, title, explicit, vocalInfo, warning, audioSrc };
            })
            .filter((t) => t.id);
    }

    /* =====================================================
                    ПЛЮРАЛИЗАЦИЯ + ДАТЫ
    ===================================================== */

    function pluralize(value, forms) {
        const abs = Math.abs(value) % 100;
        const last = abs % 10;
        if (abs > 10 && abs < 20) return forms[2];
        if (last > 1 && last < 5) return forms[1];
        if (last === 1) return forms[0];
        return forms[2];
    }

    function formatDateTime(timestampMs) {
        const date = new Date(timestampMs);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function formatRelative(timestampMs) {
        const diffSec = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
        if (diffSec < 60) return 'меньше минуты назад';

        const minutes = Math.round(diffSec / 60);
        if (minutes < 60)
            return `${minutes} ${pluralize(minutes, ['минута', 'минуты', 'минут'])} назад`;

        const hours = Math.round(diffSec / 3600);
        if (hours < 24)
            return `${hours} ${pluralize(hours, ['час', 'часа', 'часов'])} назад`;

        const days = Math.round(diffSec / 86400);
        return `${days} ${pluralize(days, ['день', 'дня', 'дней'])} назад`;
    }

    function formatTimestamp(rawTimestamp, fallbackText) {
        const tryParse = (value) => {
            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        };

        const parsed = tryParse(rawTimestamp) ?? tryParse(fallbackText);
        if (parsed === null) return fallbackText || '';

        const timestampMs = parsed * 1000;
        return `${formatRelative(timestampMs)} (${formatDateTime(timestampMs)})`;
    }

    /* =====================================================
                        ПАРСИНГ КОММЕНТОВ
    ===================================================== */

    function getLoginFromLink(link) {
        if (!link) return '';
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/(?:media|profile)\/([^/?#]+)/i);
        return match?.[1] || link.textContent?.trim() || '';
    }

    function parseComments(htmlText) {
        const doc = new DOMParser().parseFromString(htmlText, 'text/html');
        const items = doc.querySelectorAll('.comment_list li.comment_item');

        return Array.from(items)
            .map((item) => {
                const userLink = item.querySelector('.comment_username a');
                const login = getLoginFromLink(userLink) || 'Неизвестно';
                const author = MODERATOR_NAMES[login] || login;
                const text = item.querySelector('.comment_body')?.textContent?.trim() || '';
                const timeEl = item.querySelector('.comment_published .ajax-time');
                const raw = timeEl?.getAttribute('title');
                const fallback = timeEl?.textContent?.trim() || '';
                const time = formatTimestamp(raw, fallback);

                return { author, text, time };
            })
            .filter((c) => c.text);
    }

    /* =====================================================
                        FETCH
    ===================================================== */

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function fetchHtml(url, options = {}) {
        const timeoutMs = options.timeoutMs ?? NET.timeoutMs;
        const retries = options.retries ?? NET.retries;
        let lastErr = null;

        for (let attempt = 0; attempt <= retries; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const r = await fetch(url, {
                    credentials: 'include',
                    signal: controller.signal,
                });
                clearTimeout(timer);
                if (!r.ok) throw new Error(`Ошибка ${r.status}`);
                return await r.text();
            } catch (e) {
                clearTimeout(timer);
                lastErr = e;
                if (attempt < retries) await sleep(300 * (attempt + 1));
            }
        }

        if (lastErr?.name === 'AbortError')
            throw new Error(`Таймаут запроса (${Math.round(timeoutMs / 1000)}с)`);
        throw lastErr || new Error('Ошибка загрузки');
    }

    async function fetchParsed({ url, cache, key, parser, fallback = null }) {
        if (cache && cache.has(key)) return cache.get(key);

        try {
            const html = await fetchHtml(url);
            const data = parser(html);
            if (cache) cache.set(key, data);
            return data;
        } catch (e) {
            if (fallback !== null) return fallback;
            throw e;
        }
    }

    async function fetchDetails(id) {
        return fetchParsed({
            url: `https://rumedia.io/media/edit-track/${id}`,
            cache: STATE.cache,
            key: id,
            parser: parseDetails,
        });
    }

    async function fetchComments(id) {
        return fetchParsed({
            url: `https://rumedia.io/media/track/${id}`,
            cache: STATE.commentsCache,
            key: id,
            parser: parseComments,
        });
    }

    async function analyzeLyrics(id, lyrics, force = false) {
        if (!force && STATE.analysisCache.has(id)) return STATE.analysisCache.get(id);

        // text/plain -> "простой" CORS-запрос без preflight (OPTIONS).
        const res = await fetch(ANALYZE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: JSON.stringify({ token: ANALYZE_TOKEN, id, lyrics: lyrics || '', force }),
        });

        let data;
        try {
            data = await res.json();
        } catch (_) {
            throw new Error(`Ответ не JSON (HTTP ${res.status})`);
        }
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

        STATE.analysisCache.set(id, data);
        return data;
    }

    /* =====================================================
                HTML → ВСТРАИВАНИЕ ДЕТАЛЕЙ И КОММЕНТОВ
    ===================================================== */

    function buildHtml(details) {
        return `
            <div class="release-inline-details"
                style="margin-top:10px; padding:8px; background:var(--rm-muted); border-radius:6px;">
                <div><strong>Продюсер:</strong> ${details.producer}</div>
                <div><strong>Вокал:</strong> ${details.vocal}</div>
                <div style="display:flex; align-items:center; gap:5px;"><strong>Мат:</strong> ${buildAiBadge(explicitFlag(details.age))}</div>
                ${buildAiUsageHtml(details.aiArtwork)}
                ${details.apple != null ? `<div style="display:flex; align-items:center; gap:5px;"><strong>Apple:</strong> ${buildAiBadge(details.apple)}</div>` : ''}
                ${details.releaseDate ? `<div><strong>Дата релиза:</strong> ${escapeHtml(details.releaseDate)}</div>` : ''}
            </div>`;
    }

    // Мат: '18+' → true, '0+' → false, неизвестно → null (серый прочерк).
    function explicitFlag(age) {
        if (age === '18+') return true;
        if (age === '0+') return false;
        return null;
    }

    // Зелёная галочка «Да» / красный крестик «Нет» (Мат, Обложка ИИ, Apple).
    function buildAiBadge(aiUsed) {
        if (aiUsed === null || aiUsed === undefined) return '<span style="color:var(--rm-subtle);">—</span>';
        const yes = aiUsed === true;
        const color = yes ? '#16a34a' : '#dc2626';
        const icon = yes
            ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="#16a34a" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.1 14.6-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z"/></svg>'
            : '<svg width="15" height="15" viewBox="0 0 24 24" fill="#dc2626" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm3.6 13.4-1.4 1.4L12 13.4l-2.2 2.2-1.4-1.4L10.6 12 8.4 9.8l1.4-1.4L12 10.6l2.2-2.2 1.4 1.4L13.4 12l2.2 2.2z"/></svg>';
        return `<span style="display:inline-flex; align-items:center; gap:4px; color:${color}; font-weight:600;">${icon}${yes ? 'Да' : 'Нет'}</span>`;
    }

    function buildAiUsageHtml(aiUsed) {
        if (aiUsed === null || aiUsed === undefined) return '';
        return `<div style="display:flex; align-items:center; gap:5px; margin:0 0 6px; font-size:13px;">
            <strong>Обложка ИИ:</strong> ${buildAiBadge(aiUsed)}
        </div>`;
    }

    function fieldOrMissing(value, missingText) {
        const v = (value || '').trim();
        if (!v || v === '—') {
            return `<span style="color:var(--rm-destructive); font-weight:600;">${missingText || 'не указано'}</span>`;
        }
        return escapeHtml(v);
    }

    // «Артисты»: основные через запятую, фиты — после бейджа feat. Без списка — обычный текст.
    function artistsFieldHtml(list, fallback) {
        if (!Array.isArray(list) || !list.length) return fieldOrMissing(fallback, 'не указаны');
        const main = list.filter((a) => !a.feat).map((a) => escapeHtml(a.name));
        const feats = list.filter((a) => a.feat).map((a) => escapeHtml(a.name));
        if (!feats.length) return main.join(', ');
        const featHtml = `<span class="rm-feat" title="Включён переключатель feat.">feat.</span><span class="rm-feat-names">${feats.join(', ')}</span>`;
        return `<span class="rm-artists">${main.length ? `<span>${main.join(', ')}</span>` : ''}${featHtml}</span>`;
    }

    /* ---------- проверка формата «Автор» / «Продюсер» (Имя Фамилия / Имя Отчество Фамилия) ---------- */

    const COMMON_FIRST_NAMES = new Set(
        ('иван александр алексей андрей артём артем антон дмитрий денис даниил данил егор евгений игорь илья кирилл ' +
            'константин максим михаил никита николай олег павел роман руслан сергей степан тимур фёдор федор юрий ярослав ' +
            'владимир владислав вадим виктор виталий вячеслав глеб григорий марк матвей платон арсений богдан тимофей лев ' +
            'георгий семён семен эдуард эмиль артур асхат айдар ринат рустам шамиль анна анастасия алина александра валерия ' +
            'виктория дарья екатерина елена ирина ксения мария наталья ольга полина софья софия татьяна юлия вероника алиса ' +
            'ева милана диана кристина марина светлана людмила любовь надежда вера яна елизавета ' +
            'john james michael david daniel alex alexander max mark tom anna maria kate emma').split(' ')
    );
    const AUTHOR_JUNK_RE = /\b(prod|beats?|music|records?|feat|ft|official|studio|band|dj|mc)\b/i;
    const PATRONYMIC_RE = /(ович|евич|ич|овна|евна|ична|инична)$/i;

    // Возвращает причину, если имя не похоже на «Имя Фамилия» / «Имя Отчество Фамилия», иначе null.
    function checkPersonName(raw) {
        const name = String(raw || '').trim().replace(/\s+/g, ' ');
        if (!name || /^народн(ые слова|ая музыка)$/i.test(name)) return null;
        const words = name.split(' ');
        const low = words.map((w) => w.toLowerCase());
        if (words.length > 1 && words.some((w) => /^[A-ZА-ЯЁ]\.?$/i.test(w))) return 'инициалы вместо полного имени';
        if (/[0-9_@.$#!?*+=/\\|<>~]/.test(name)) return 'цифры или символы — похоже на ник';
        if (AUTHOR_JUNK_RE.test(name)) return 'лишние слова (prod / beats / music…)';
        if (words.length === 1) return 'одно слово — похоже на ник, нужно Имя Фамилия';
        if (words.length > 3) return 'больше трёх слов';
        if (/[а-яё]/i.test(name) && /[a-z]/i.test(name)) return 'смешаны кириллица и латиница';
        if (words.some((w) => !/^[A-ZА-ЯЁ][a-zа-яё]*(?:[-'’][A-ZА-ЯЁa-zа-яё][a-zа-яё]*)*$/.test(w))) return 'регистр: каждое слово с заглавной, остальные строчные';
        // Отчество последним — порядок неверный, подсказываем, как именно перепутано.
        if (words.length === 3 && PATRONYMIC_RE.test(low[2]) && !PATRONYMIC_RE.test(low[1])) {
            if (COMMON_FIRST_NAMES.has(low[0])) return 'порядок: Имя Фамилия Отчество';
            if (COMMON_FIRST_NAMES.has(low[1])) return 'порядок: Фамилия Имя Отчество';
            return 'отчество должно стоять вторым: Имя Отчество Фамилия';
        }
        if (words.length === 3 && /[а-яё]/.test(low[1]) && !PATRONYMIC_RE.test(low[1])) return 'в середине ожидается отчество';
        if (!COMMON_FIRST_NAMES.has(low[0]) && COMMON_FIRST_NAMES.has(low[1])) return 'порядок: похоже на Фамилия Имя';
        return null;
    }

    // Значение поля «Автор»/«Продюсер»: подозрительные имена подсвечены, причина — в подсказке у «!».
    function authorFieldHtml(value, missingText) {
        const v = String(value || '').trim();
        if (!v || v === '—') return fieldOrMissing(v, missingText);
        const people = v.split(',').map((p) => p.trim()).filter(Boolean);
        const checked = people.map((p) => ({ p, issue: checkPersonName(p) }));
        const names = checked
            .map(({ p, issue }) =>
                issue
                    ? `<span class="rm-author is-bad">${escapeHtml(p)}<span class="rm-author-warn" title="${escapeHtml(issue)}">!</span></span>`
                    : escapeHtml(p)
            )
            .join(', ');
        return names;
    }

    // Графы «Артисты / Автор / Продюсер» — широкие (длинные имена), остальные — короткие.
    const WIDE_FIELDS = new Set(['Артисты', 'Автор', 'Продюсер']);
    const infoField = (label, value) =>
        `<div class="rai-field${WIDE_FIELDS.has(label) ? ' rai-field--wide' : ''}"><div class="rai-label">${label}</div><div class="rai-value">${value}</div></div>`;

    function buildAlbumInfoHtml(info, row) {
        const field = infoField;

        return `<div class="release-album-info rm-fields rm-fields--album">
                ${field('Артисты', artistsFieldHtml(info.artistList, info.artists))}
                ${field('Автор', authorFieldHtml(info.written, 'не указан'))}
                ${field('Apple', buildAiBadge(info.apple))}
                ${field('Жанр', fieldOrMissing(row?.dataset.rmGenre, 'не указан'))}
                ${field('Дата релиза', fieldOrMissing(info.releaseDate, 'не указана'))}
                ${field('Обложка ИИ', buildAiBadge(info.aiUsed))}
            </div>`;
    }

    function renderAlbumInfo(row, info) {
        if (!info) return;
        const hasData =
            info.artists || info.written || info.releaseDate ||
            info.trackCount != null || info.aiUsed != null;
        if (!hasData) {
            removeSkeletons(row);
            return;
        }

        const cell = row.querySelector('td:nth-child(4)');
        if (!cell) return;

        const wrap = document.createElement('div');
        wrap.innerHTML = buildAlbumInfoHtml(info, row);

        const old = cell.querySelector('.release-album-info');
        if (old) old.replaceWith(wrap.firstElementChild);
        else cell.appendChild(wrap.firstElementChild);
    }

    /* =====================================================
              СВОРАЧИВАЕМЫЙ СПИСОК ТРЕКОВ АЛЬБОМА
    ===================================================== */

    /* ---------- свой аудиоплеер (вместо стандартного <audio controls>) ---------- */

    const PLAYER_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const PLAYER_ICONS = {
        play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
        pause: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
        sound: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
        soundLow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>',
        muted: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor"/><path d="m16 9 6 6M22 9l-6 6"/></svg>',
    };

    function ensurePlayerStyles() {
        if (document.getElementById('rm-player-styles')) return;
        const style = document.createElement('style');
        style.id = 'rm-player-styles';
        style.textContent = `
            .rm-player { display:flex; align-items:center; gap:10px; width:100%; max-width:420px; box-sizing:border-box;
                height:40px; padding:0 8px 0 5px; border:1px solid var(--rm-border); border-radius:999px; background:#fff;
                font-family:var(--rm-font); user-select:none; }
            .rm-player audio { display:none !important; }
            .rm-pl-play { flex:none; display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px;
                padding:0; border:none; border-radius:50%; background:var(--rm-fg); color:#fff; cursor:pointer; }
            .rm-pl-play:hover { background:var(--rm-fg); }
            .rm-pl-play svg { margin-left:1px; }
            .rm-player.is-playing .rm-pl-play svg { margin-left:0; }
            .rm-player.is-loading .rm-pl-play svg { display:none; }
            .rm-player.is-loading .rm-pl-play::after { content:''; width:12px; height:12px; border:2px solid rgba(255,255,255,.35);
                border-top-color:#fff; border-radius:50%; animation:rm-pl-spin .7s linear infinite; }
            @keyframes rm-pl-spin { to { transform:rotate(360deg); } }
            .rm-pl-time { flex:none; min-width:34px; font-size:12px; font-variant-numeric:tabular-nums; color:var(--rm-muted-fg); }
            .rm-pl-time.is-cur { color:var(--rm-fg); font-weight:500; text-align:right; }
            .rm-pl-track { position:relative; flex:1; min-width:60px; height:20px; display:flex; align-items:center; cursor:pointer;
                outline:none; touch-action:none; }
            .rm-pl-rail { position:relative; width:100%; height:4px; border-radius:999px; background:var(--rm-border); overflow:hidden; }
            .rm-pl-buf, .rm-pl-fill { position:absolute; left:0; top:0; bottom:0; width:0; border-radius:inherit; }
            .rm-pl-buf { background:var(--rm-muted-strong); }
            .rm-pl-fill { background:var(--rm-fg); }
            .rm-pl-thumb { position:absolute; top:50%; left:0; width:12px; height:12px; margin:-6px 0 0 -6px; border-radius:50%;
                background:var(--rm-fg); box-shadow:0 0 0 3px #fff; opacity:0; transition:opacity .12s; pointer-events:none; }
            .rm-pl-track:hover .rm-pl-thumb, .rm-pl-track:focus-visible .rm-pl-thumb, .rm-player.is-seeking .rm-pl-thumb { opacity:1; }
            .rm-pl-btn { flex:none; display:inline-flex; align-items:center; justify-content:center; height:26px; min-width:26px;
                padding:0 6px; border:none; border-radius:7px; background:transparent; font:inherit; font-size:12px; font-weight:600;
                color:var(--rm-muted-fg); cursor:pointer; }
            .rm-pl-btn:hover { background:var(--rm-accent); color:var(--rm-fg); }
            .rm-pl-speed.is-changed { color:var(--rm-link); }
            .rm-pl-speed-wrap, .rm-pl-vol-wrap { position:relative; flex:none; }
            .rm-pl-vol-menu { width:180px; padding:6px 10px 12px; }
            .rm-pl-vol-menu .rm-pl-menu-title { display:flex; justify-content:space-between; padding:4px 0 10px; }
            .rm-pl-vol-val { font-variant-numeric:tabular-nums; color:var(--rm-fg); letter-spacing:0; }
            .rm-pl-vol-slider { position:relative; height:18px; display:flex; align-items:center; cursor:pointer;
                touch-action:none; outline:none; }
            .rm-pl-vol-rail { position:relative; width:100%; height:6px; border-radius:999px; background:var(--rm-muted-strong); overflow:hidden; }
            .rm-pl-vol-fill { position:absolute; left:0; top:0; bottom:0; border-radius:inherit; background:var(--rm-primary); }
            .rm-pl-vol-thumb { position:absolute; top:50%; width:16px; height:16px; margin:-8px 0 0 -8px; border-radius:50%;
                background:#fff; border:1px solid var(--rm-primary); box-shadow:var(--rm-shadow-sm); pointer-events:none; }
            .rm-pl-vol-slider:focus-visible .rm-pl-vol-thumb { box-shadow:var(--rm-ring-shadow); }
            .rm-pl-menu { position:absolute; right:0; bottom:calc(100% + 8px); z-index:30; min-width:96px; padding:4px;
                border:1px solid var(--rm-border); border-radius:10px; background:#fff; box-shadow:0 8px 24px rgba(17,24,39,.14); }
            .rm-pl-menu[hidden] { display:none; }
            .rm-pl-menu.is-below { top:calc(100% + 8px); bottom:auto; }
            .rm-pl-menu-title { padding:4px 8px 6px; font-size:10.5px; font-weight:600; letter-spacing:.08em;
                text-transform:uppercase; color:var(--rm-subtle); }
            .rm-pl-menu button { display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%;
                padding:6px 8px; border:none; border-radius:7px; background:transparent; font:inherit; font-size:13px;
                font-variant-numeric:tabular-nums; color:var(--rm-fg); text-align:left; cursor:pointer; }
            .rm-pl-menu button:hover { background:var(--rm-accent); }
            .rm-pl-menu button.is-current { font-weight:600; }
            .rm-pl-menu button svg { visibility:hidden; color:var(--rm-fg); }
            .rm-pl-menu button.is-current svg { visibility:visible; }
            .rm-player.is-error { border-color:var(--rm-destructive-border); }
            .rm-player.is-error .rm-pl-time { color:var(--rm-destructive); }
        `;
        document.head.appendChild(style);
    }

    const PLAYER_VOLUME_KEY = 'rm-player-volume';

    function loadPlayerVolume() {
        try {
            const v = parseFloat(localStorage.getItem(PLAYER_VOLUME_KEY));
            return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
        } catch (_) {
            return null;
        }
    }

    function savePlayerVolume(v) {
        try {
            localStorage.setItem(PLAYER_VOLUME_KEY, String(v));
        } catch (_) {
            /* хранилище недоступно — просто не запоминаем */
        }
    }

    function formatPlayerTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) return '–:––';
        const s = Math.floor(sec);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    // Оборачивает <audio> в свой плеер. Сам <audio> остаётся (скрытым) и играет звук.
    function upgradeAudio(audio) {
        if (!audio || audio.dataset.rmPlayer) return;
        audio.dataset.rmPlayer = '1';
        ensurePlayerStyles();
        audio.controls = false;
        audio.removeAttribute('style');

        const player = document.createElement('div');
        player.className = 'rm-player';
        player.innerHTML = `
            <button type="button" class="rm-pl-play" title="Воспроизвести">${PLAYER_ICONS.play}</button>
            <span class="rm-pl-time is-cur">0:00</span>
            <div class="rm-pl-track" role="slider" tabindex="0" aria-label="Перемотка" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
                <div class="rm-pl-rail"><div class="rm-pl-buf"></div><div class="rm-pl-fill"></div></div>
                <div class="rm-pl-thumb"></div>
            </div>
            <span class="rm-pl-time rm-pl-dur">–:––</span>
            <div class="rm-pl-speed-wrap">
                <button type="button" class="rm-pl-btn rm-pl-speed" title="Скорость воспроизведения" aria-haspopup="true" aria-expanded="false">1×</button>
                <div class="rm-pl-menu" hidden>
                    <div class="rm-pl-menu-title">Скорость</div>
                    ${PLAYER_SPEEDS.map((v) => `<button type="button" data-speed="${v}">${v === 1 ? 'Обычная' : `${v}×`}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg></button>`).join('')}
                </div>
            </div>
            <div class="rm-pl-vol-wrap">
                <button type="button" class="rm-pl-btn rm-pl-vol" title="Громкость" aria-haspopup="true" aria-expanded="false">${PLAYER_ICONS.sound}</button>
                <div class="rm-pl-menu rm-pl-vol-menu" hidden>
                    <div class="rm-pl-menu-title">Громкость <span class="rm-pl-vol-val">100%</span></div>
                    <div class="rm-pl-vol-slider" role="slider" tabindex="0" aria-label="Громкость" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100">
                        <div class="rm-pl-vol-rail"><div class="rm-pl-vol-fill"></div></div>
                        <div class="rm-pl-vol-thumb"></div>
                    </div>
                </div>
            </div>`;
        audio.replaceWith(player);
        player.appendChild(audio);

        const q = (sel) => player.querySelector(sel);
        const playBtn = q('.rm-pl-play');
        const cur = q('.rm-pl-time.is-cur');
        const dur = q('.rm-pl-dur');
        const track = q('.rm-pl-track');
        const fill = q('.rm-pl-fill');
        const buf = q('.rm-pl-buf');
        const thumb = q('.rm-pl-thumb');
        const speedBtn = q('.rm-pl-speed');
        const speedMenu = q('.rm-pl-speed-wrap .rm-pl-menu');
        const volBtn = q('.rm-pl-vol');
        const volMenu = q('.rm-pl-vol-menu');
        const volSlider = q('.rm-pl-vol-slider');
        const volFill = q('.rm-pl-vol-fill');
        const volThumb = q('.rm-pl-vol-thumb');
        const volVal = q('.rm-pl-vol-val');
        let seeking = false;
        let pendingRatio = null; // перемотка до загрузки длительности

        const setProgress = (ratio) => {
            const pct = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
            fill.style.width = pct;
            thumb.style.left = pct;
            track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
        };
        const syncTime = () => {
            const d = audio.duration;
            dur.textContent = formatPlayerTime(d);
            if (!seeking) {
                cur.textContent = formatPlayerTime(audio.currentTime || 0);
                setProgress(Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0);
            }
        };
        const syncBuffer = () => {
            const d = audio.duration;
            if (!Number.isFinite(d) || d <= 0 || !audio.buffered.length) return;
            buf.style.width = `${(audio.buffered.end(audio.buffered.length - 1) / d) * 100}%`;
        };
        const syncPlaying = () => {
            const playing = !audio.paused && !audio.ended;
            player.classList.toggle('is-playing', playing);
            playBtn.innerHTML = playing ? PLAYER_ICONS.pause : PLAYER_ICONS.play;
            playBtn.title = playing ? 'Пауза' : 'Воспроизвести';
        };
        const seekTo = (ratio) => {
            const d = audio.duration;
            if (Number.isFinite(d) && d > 0) audio.currentTime = Math.max(0, Math.min(1, ratio)) * d;
            else {
                pendingRatio = ratio;
                if (audio.preload === 'none') audio.preload = 'metadata';
                audio.load();
            }
        };
        const ratioFromEvent = (e) => {
            const r = track.getBoundingClientRect();
            return r.width ? (e.clientX - r.left) / r.width : 0;
        };

        playBtn.addEventListener('click', () => {
            if (audio.paused || audio.ended) {
                player.classList.remove('is-error');
                audio.play().catch(() => {});
            } else audio.pause();
        });
        track.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            seeking = true;
            player.classList.add('is-seeking');
            track.setPointerCapture(e.pointerId);
            const ratio = ratioFromEvent(e);
            setProgress(ratio);
            cur.textContent = formatPlayerTime(ratio * audio.duration);
        });
        track.addEventListener('pointermove', (e) => {
            if (!seeking) return;
            const ratio = Math.max(0, Math.min(1, ratioFromEvent(e)));
            setProgress(ratio);
            cur.textContent = formatPlayerTime(ratio * audio.duration);
        });
        const endSeek = (e) => {
            if (!seeking) return;
            seeking = false;
            player.classList.remove('is-seeking');
            seekTo(ratioFromEvent(e));
        };
        track.addEventListener('pointerup', endSeek);
        track.addEventListener('pointercancel', () => {
            seeking = false;
            player.classList.remove('is-seeking');
            syncTime();
        });
        track.addEventListener('keydown', (e) => {
            const step = { ArrowRight: 5, ArrowLeft: -5 }[e.key];
            if (step && Number.isFinite(audio.duration)) {
                e.preventDefault();
                audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + step));
            } else if (e.key === ' ') {
                e.preventDefault();
                playBtn.click();
            }
        });
        // Всплывающие окошки «Скорость» и «Громкость»: одно открыто за раз, закрываются кликом мимо и Esc.
        const popups = [
            { btn: speedBtn, menu: speedMenu, onOpen: () => syncSpeedMenu() },
            { btn: volBtn, menu: volMenu, onOpen: () => syncVolume() },
        ];
        const onOutside = (e) => {
            if (!popups.some((p) => p.menu.parentElement.contains(e.target))) closeMenu();
        };
        const onEsc = (e) => {
            if (e.key === 'Escape') closeMenu();
        };
        function closeMenu() {
            popups.forEach((p) => {
                p.menu.hidden = true;
                p.btn.setAttribute('aria-expanded', 'false');
            });
            document.removeEventListener('pointerdown', onOutside, true);
            document.removeEventListener('keydown', onEsc, true);
        }
        const syncSpeedMenu = () => {
            speedMenu.querySelectorAll('button[data-speed]').forEach((b) => {
                b.classList.toggle('is-current', Number(b.dataset.speed) === audio.playbackRate);
            });
        };
        popups.forEach((p) => {
            p.btn.addEventListener('click', () => {
                const wasOpen = !p.menu.hidden;
                closeMenu();
                if (wasOpen) return;
                p.onOpen();
                p.menu.classList.remove('is-below');
                p.menu.hidden = false;
                // сверху не помещается (плеер у верхнего края экрана) — открываем вниз
                if (p.menu.getBoundingClientRect().top < 8) p.menu.classList.add('is-below');
                p.btn.setAttribute('aria-expanded', 'true');
                document.addEventListener('pointerdown', onOutside, true);
                document.addEventListener('keydown', onEsc, true);
            });
        });
        speedMenu.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-speed]');
            if (!b) return;
            audio.playbackRate = Number(b.dataset.speed);
            closeMenu();
        });
        // Громкость: ползунок 0–100 %, колесо мыши над кнопкой — по 5 %. Запоминается для всех плееров.
        const setVolume = (v) => {
            const vol = Math.max(0, Math.min(1, v));
            audio.muted = false;
            audio.volume = vol;
            savePlayerVolume(vol);
            document.querySelectorAll('.rm-player audio').forEach((other) => {
                if (other !== audio) other.volume = vol;
            });
        };
        function syncVolume() {
            const pct = Math.round((audio.muted ? 0 : audio.volume) * 100);
            volFill.style.width = `${pct}%`;
            volThumb.style.left = `${pct}%`;
            volSlider.setAttribute('aria-valuenow', String(pct));
            volVal.textContent = `${pct}%`;
            volBtn.innerHTML = pct === 0 ? PLAYER_ICONS.muted : pct < 50 ? PLAYER_ICONS.soundLow : PLAYER_ICONS.sound;
            volBtn.title = `Громкость: ${pct}%`;
        }
        // Свой ползунок (как полоса перемотки): стандартный range в Firefox внутри плеера не перетаскивается.
        let volDragging = false;
        const volFromEvent = (e) => {
            const r = volSlider.getBoundingClientRect();
            return r.width ? (e.clientX - r.left) / r.width : 0;
        };
        volSlider.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            volDragging = true;
            try {
                volSlider.setPointerCapture(e.pointerId);
            } catch (_) {
                /* без захвата тоже работает, просто хуже при уводе мыши */
            }
            volSlider.focus();
            setVolume(volFromEvent(e));
        });
        volSlider.addEventListener('pointermove', (e) => {
            if (volDragging) setVolume(volFromEvent(e));
        });
        const endVolDrag = () => {
            volDragging = false;
        };
        volSlider.addEventListener('pointerup', endVolDrag);
        volSlider.addEventListener('pointercancel', endVolDrag);
        volSlider.addEventListener('keydown', (e) => {
            const step = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05 }[e.key];
            if (step) {
                e.preventDefault();
                setVolume(audio.volume + step);
            } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                setVolume(e.key === 'End' ? 1 : 0);
            }
        });
        volBtn.addEventListener('wheel', (e) => {
            e.preventDefault();
            setVolume(audio.volume + (e.deltaY < 0 ? 0.05 : -0.05));
        }, { passive: false });
        const savedVolume = loadPlayerVolume();
        if (savedVolume != null) audio.volume = savedVolume;

        audio.addEventListener('ratechange', () => {
            speedBtn.textContent = `${audio.playbackRate}×`;
            speedBtn.classList.toggle('is-changed', audio.playbackRate !== 1);
        });
        audio.addEventListener('volumechange', syncVolume);
        audio.addEventListener('play', () => {
            const saved = loadPlayerVolume();
            if (saved != null && Math.abs(audio.volume - saved) > 0.001) audio.volume = saved;
            // одновременно играет только один трек
            document.querySelectorAll('audio').forEach((other) => {
                if (other !== audio && !other.paused) other.pause();
            });
            syncPlaying();
        });
        audio.addEventListener('pause', syncPlaying);
        audio.addEventListener('ended', syncPlaying);
        audio.addEventListener('waiting', () => player.classList.add('is-loading'));
        ['playing', 'canplay', 'pause'].forEach((ev) => audio.addEventListener(ev, () => player.classList.remove('is-loading')));
        audio.addEventListener('loadedmetadata', () => {
            if (pendingRatio != null) {
                audio.currentTime = pendingRatio * audio.duration;
                pendingRatio = null;
            }
            syncTime();
        });
        audio.addEventListener('timeupdate', syncTime);
        audio.addEventListener('durationchange', syncTime);
        audio.addEventListener('progress', syncBuffer);
        audio.addEventListener('error', () => {
            player.classList.remove('is-loading');
            player.classList.add('is-error');
            dur.textContent = 'ошибка';
        }, true);

        syncTime();
        syncBuffer();
        syncPlaying();
        syncVolume();
        return player;
    }

    function ensureTracksStyles() {
        if (document.getElementById('release-tracks-styles')) return;
        const style = document.createElement('style');
        style.id = 'release-tracks-styles';
        style.textContent = `
            .release-tracks-toggle {
                display:inline-flex; align-items:center; gap:8px;
                padding:6px 12px; border:none; border-radius:2px;
                box-shadow:0 2px 5px rgba(0,0,0,0.16), 0 2px 10px rgba(0,0,0,0.12);
                background-color:var(--rm-link); color:#fff;
                font-size:13px; font-weight:500;
                cursor:pointer; user-select:none;
            }
            .release-tracks-toggle:hover,
            .release-tracks-toggle:focus,
            .release-tracks-toggle:active {
                background-color:var(--rm-link); color:#fff;
            }
            .release-tracks-toggle .release-tracks-count {
                display:inline-flex; align-items:center; justify-content:center;
                min-width:20px; height:18px; padding:0 6px; border-radius:999px;
                background:rgba(255,255,255,0.25); color:#fff; font-size:12px; font-weight:700;
            }
            .release-tracks-chevron { transition:transform .2s ease; }
        `;
        document.head.appendChild(style);
    }

    function buildAlbumTracksHtml(tracks) {
        ensureTracksStyles();
        const cards = tracks
            .map(
                (t, i) => `
            <div class="release-track-card" data-track-id="${escapeHtml(t.id)}" data-idx="${i}"
                style="border:1px solid var(--rm-border); border-radius:10px; padding:12px 14px; margin-bottom:10px; background:#fff;">
                <div style="display:flex; align-items:center; flex-wrap:wrap; gap:8px;">
                    <span style="font-weight:600; font-size:14px; color:var(--rm-fg);">${escapeHtml(t.title || '—')}</span>
                    ${t.explicit ? `<span style="font-size:11px; color:var(--rm-subtle);">${escapeHtml(t.explicit)}</span>` : ''}
                    <span class="tc-icons" style="display:inline-flex; align-items:center; gap:6px; margin-left:auto;"></span>
                </div>
                ${t.vocalInfo ? `<div style="font-size:12px; color:var(--rm-muted-fg); margin-top:4px;">${escapeHtml(t.vocalInfo)}</div>` : ''}
                <div class="tc-authors" style="font-size:12px; color:var(--rm-muted-fg); margin-top:2px;"></div>
                ${t.warning ? `<div style="font-size:12px; color:var(--rm-destructive); margin-top:4px;">${escapeHtml(t.warning)}</div>` : ''}
                ${t.audioSrc ? `<div style="margin-top:10px;"><audio controls preload="none" src="${escapeHtml(t.audioSrc)}" style="width:100%; max-width:360px; height:34px;"></audio></div>` : ''}
            </div>`
            )
            .join('');

        return `
            <div class="release-album-tracks" style="margin-bottom:14px;">
                <div class="release-tracks-toggle" role="button" tabindex="0">
                    <span>Треки</span>
                    <span class="release-tracks-count">${tracks.length}</span>
                    <svg class="release-tracks-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" stroke-width="2.2">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                </div>
                <div class="release-tracks-body" style="display:none; margin-top:12px;">${cards}</div>
            </div>`;
    }

    function initTrackCards(container) {
        container.querySelectorAll('.release-track-card').forEach((card) => {
            const id = card.dataset.trackId;
            if (!id || card.dataset.inited) return;
            card.dataset.inited = '1';
            upgradeAudio(card.querySelector('audio'));

            const icons = card.querySelector('.tc-icons');
            if (icons) {
                const lyricsBtn = createLyricsIconButton();
                lyricsBtn.style.marginLeft = '0';
                lyricsBtn.style.verticalAlign = 'middle';
                lyricsBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        const d = await fetchDetails(id);
                        showTextModal('Текст песни', d.lyrics || 'Текст песни отсутствует.');
                    } catch (err) {
                        showTextModal('Текст песни', `Ошибка загрузки: ${err.message || err}`);
                    }
                });
                icons.appendChild(lyricsBtn);

                const analyzeBtn = createAiAnalyzerButton(id);
                icons.appendChild(analyzeBtn);
                analyzeAndRender(analyzeBtn, id);
            }

            const authorsEl = card.querySelector('.tc-authors');
            if (authorsEl) {
                fetchTrackAuthors(id).then((info) => {
                    if (!info) return;
                    authorsEl.innerHTML =
                        `Автор: <b>${fieldOrMissing(info.written, 'не указан')}</b> · ` +
                        `Продюсер: <b>${fieldOrMissing(info.producer, 'не указан')}</b>`;
                });
            }
        });
    }

    function wireAlbumTracks(container) {
        const toggle = container.querySelector('.release-tracks-toggle');
        const body = container.querySelector('.release-tracks-body');
        const chevron = container.querySelector('.release-tracks-chevron');
        if (!toggle || !body) return;

        let initialized = false;
        const toggleOpen = () => {
            const isOpen = body.style.display !== 'none';
            body.style.display = isOpen ? 'none' : 'block';
            if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
            if (!isOpen && !initialized) {
                initialized = true;
                initTrackCards(container);
            }
        };

        toggle.addEventListener('click', toggleOpen);
        toggle.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleOpen();
            }
        });
    }

    function renderAlbumBlock(row, tracks, comments) {
        const tracksHtml = tracks && tracks.length ? buildAlbumTracksHtml(tracks) : '';
        const td = insertCommentsRow(row, false, tracksHtml + buildCommentsHtml(comments, null));
        const tracksContainer = td.querySelector('.release-album-tracks');
        if (tracksContainer) wireAlbumTracks(tracksContainer);
    }

    function buildCommentsHtml(comments, aiUsed) {
        const aiLine = buildAiUsageHtml(aiUsed);

        if (!comments.length)
            return `<div class="release-inline-comments"><h4 style="margin:0 0 6px 0;">Комментарии</h4>${aiLine}<p style="margin:0;">Комментариев нет.</p></div>`;

        // Больше COMMENTS_COLLAPSE_OVER — показываем только самые свежие (сайт отдаёт их первыми).
        const collapse = comments.length > COMMENTS_COLLAPSE_OVER;
        const hiddenCount = comments.length - COMMENTS_VISIBLE;

        const items = comments
            .map((c, i) => {
                const extra = collapse && i >= COMMENTS_VISIBLE;
                return `
            <li${extra ? ' class="release-comment-extra"' : ''} style="margin-bottom:8px; line-height:1.4;${extra ? ' display:none;' : ''}">
                <strong>${c.author}:</strong> ${c.text}
                <div style="color:var(--rm-fg-soft); font-size:12px;">${c.time}</div>
            </li>
        `;
            })
            .join('');

        const expandBtn = collapse
            ? `<button type="button" class="release-comments-expand" data-hidden="${hiddenCount}"
                style="margin-top:10px; border:1px solid var(--rm-border); background:#fff; color:var(--rm-fg); border-radius:8px;
                padding:5px 12px; font-size:12.5px; font-weight:500; cursor:pointer;">Развернуть (ещё ${hiddenCount})</button>`
            : '';

        return `
            <div class="release-inline-comments">
                <h4 style="margin:0 0 6px 0;">Комментарии</h4>
                ${aiLine}
                <ul style="padding-left:18px; margin:0;">${items}</ul>
                ${expandBtn}
            </div>`;
    }

    function onCommentsExpandClick(e) {
        const btn = e.target.closest('.release-comments-expand');
        if (!btn) return;
        e.preventDefault();

        const box = btn.closest('.release-inline-comments');
        if (!box) return;

        const expanded = btn.dataset.expanded === '1';
        box.querySelectorAll('.release-comment-extra').forEach((li) => {
            li.style.display = expanded ? 'none' : '';
        });
        btn.dataset.expanded = expanded ? '' : '1';
        btn.textContent = expanded ? `Развернуть (ещё ${btn.dataset.hidden})` : 'Свернуть';
    }

    function findRecognitionRow(row) {
        let pointer = row.nextElementSibling;
        while (pointer) {
            const txt = pointer.querySelector('td')?.textContent?.trim();
            if (txt && txt.startsWith('Распознание')) return pointer;
            if (pointer.querySelector('form input[name="audio_id"]')) break;
            pointer = pointer.nextElementSibling;
        }
        return null;
    }

    function buildSongFieldsHtml(details, row) {
        const field = infoField;
        const written = details.written && details.written !== '—' ? details.written : row.dataset.rmAuthor;

        return `<div class="release-inline-details release-album-info rm-fields rm-fields--song">
                ${field('Артисты', artistsFieldHtml(details.artistList, row.dataset.rmArtists))}
                ${field('Автор', authorFieldHtml(written, 'не указан'))}
                ${field('Продюсер', authorFieldHtml(details.producer, 'не указан'))}
                ${field('Вокал', escapeHtml(details.vocal || '—'))}
                ${field('Мат', buildAiBadge(explicitFlag(details.age)))}
                ${field('Обложка ИИ', buildAiBadge(details.aiArtwork))}
                ${field('Apple', buildAiBadge(details.apple))}
                ${field('Жанр', fieldOrMissing(row.dataset.rmGenre, 'не указан'))}
                ${field('Дата релиза', fieldOrMissing(details.releaseDate, 'не указана'))}
            </div>`;
    }

    function renderDetails(row, details) {
        const cell = row.querySelector('td:nth-child(4)');
        if (!cell) return;

        const wrap = document.createElement('div');
        wrap.innerHTML = document.body.classList.contains('rm-songs')
            ? buildSongFieldsHtml(details, row)
            : buildHtml(details);

        const old = cell.querySelector('.release-inline-details');
        if (old) old.replaceWith(wrap.firstElementChild);
        else (cell.querySelector('.rm-details-slot') || cell).appendChild(wrap.firstElementChild);
    }

    function insertCommentsRow(row, useRecognitionRow, innerHtml) {
        const base = useRecognitionRow ? findRecognitionRow(row) || row : row;

        const tr = document.createElement('tr');
        tr.className = 'release-comments-row';

        const td = document.createElement('td');
        td.colSpan = row.children.length;
        td.style.background = '#fbfbfb';
        td.style.borderTop = '1px solid var(--rm-border)';
        td.innerHTML = innerHtml;

        tr.appendChild(td);

        const next = base.nextElementSibling;
        if (next?.classList.contains('release-comments-row')) next.replaceWith(tr);
        else base.insertAdjacentElement('afterend', tr);
        return td;
    }

    function renderComments(row, comments, useRecognitionRow = true, aiUsed = null) {
        insertCommentsRow(row, useRecognitionRow, buildCommentsHtml(comments, aiUsed));
    }

    /* ---------- скелетоны (только в редизайне списков) ---------- */

    const SKEL_FIELDS = {
        song: [['Артисты', 80], ['Автор', 130], ['Продюсер', 120], ['Вокал', 40], ['Мат', 40], ['Обложка ИИ', 44], ['Apple', 40], ['Жанр', 70], ['Дата релиза', 76]],
        album: [['Артисты', 90], ['Автор', 140], ['Apple', 40], ['Жанр', 70], ['Дата релиза', 76], ['Обложка ИИ', 44]],
    };

    const skelBar = (width, extra = '') => `<span class="rm-skel${extra}" style="width:${width}px"></span>`;

    function buildFieldsSkeleton(kind, extraClass = '') {
        const fields = SKEL_FIELDS[kind]
            .map(([label, w]) => infoField(label, skelBar(w)))
            .join('');
        return `<div class="release-album-info rm-fields rm-fields--${kind} rm-skel-fields${extraClass}" aria-busy="true">${fields}</div>`;
    }

    function buildCommentsSkeleton(withTracks) {
        const item = (w, meta) => `<li><span class="rm-skel" style="width:${w}%"></span><div>${skelBar(meta, ' rm-skel--sm')}</div></li>`;
        return `${withTracks ? '<div class="rm-skel rm-skel--btn" style="width:108px; margin-bottom:14px;"></div>' : ''}
            <div class="release-inline-comments rm-skel-comments" aria-busy="true">
                <h4>Комментарии</h4>
                <ul>${item(58, 150)}${item(36, 120)}</ul>
            </div>`;
    }

    // Пока грузятся данные трека — серые плашки на месте полей.
    function renderDetailsSkeleton(row) {
        if (!document.body.classList.contains('rm-songs')) return;
        const slot = row.querySelector('td:nth-child(4) .rm-details-slot');
        if (!slot || slot.querySelector('.release-inline-details')) return;
        slot.insertAdjacentHTML('beforeend', buildFieldsSkeleton('song', ' release-inline-details'));
    }

    function renderAlbumInfoSkeleton(row) {
        if (!document.body.classList.contains('rm-albums')) return;
        const cell = row.querySelector('td:nth-child(4)');
        if (!cell || cell.querySelector('.release-album-info')) return;
        cell.insertAdjacentHTML('beforeend', buildFieldsSkeleton('album'));
    }

    function removeSkeletons(row) {
        row.querySelectorAll('.rm-skel-fields').forEach((el) => el.remove());
    }

    function renderCommentsLoading(row, useRecognitionRow = true) {
        if (document.body.classList.contains('rm-redesign')) {
            insertCommentsRow(row, useRecognitionRow, buildCommentsSkeleton(document.body.classList.contains('rm-albums')));
            return;
        }
        ensureAnalyzerStyles();
        insertCommentsRow(
            row,
            useRecognitionRow,
            `<div style="display:flex; align-items:center; gap:8px; color:var(--rm-fg-soft); font-size:13px;">
                <span class="release-ai-spinner"></span> Загрузка комментариев…
            </div>`
        );
    }

    function renderCommentsError(row, useRecognitionRow, message, retryFn) {
        const td = insertCommentsRow(
            row,
            useRecognitionRow,
            `<div style="display:flex; align-items:center; flex-wrap:wrap; gap:10px; font-size:13px;">
                <span style="color:var(--rm-destructive);">Ошибка: ${escapeHtml(message)}</span>
                <button type="button" class="release-retry-btn"
                    style="border:1px solid var(--rm-muted-strong); background:#fff; color:var(--rm-fg); padding:4px 10px; border-radius:6px; cursor:pointer; font-size:12px;">
                    Повторить
                </button>
            </div>`
        );
        const btn = td.querySelector('.release-retry-btn');
        if (btn && retryFn) {
            btn.addEventListener('click', () => {
                renderCommentsLoading(row, useRecognitionRow);
                retryFn();
            });
        }
    }

    function ensureTextModal() {
        let overlay = document.getElementById('release-text-modal');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'release-text-modal';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.55);
            z-index: 1000000;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 18px;
        `;

        const card = document.createElement('div');
        card.style.cssText = `
            width: min(760px, 95vw);
            max-height: 88vh;
            overflow: hidden;
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
            display: flex;
            flex-direction: column;
        `;

        const head = document.createElement('div');
        head.style.cssText =
            'display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--rm-border-soft);';

        const title = document.createElement('strong');
        title.id = 'release-text-modal-title';
        title.textContent = 'Данные';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = 'Закрыть';
        closeBtn.style.cssText =
            'border:1px solid var(--rm-border);background:var(--rm-muted-soft);padding:6px 10px;border-radius:6px;cursor:pointer;';

        const body = document.createElement('pre');
        body.id = 'release-text-modal-body';
        body.style.cssText = `
            margin: 0;
            padding: 14px;
            overflow: auto;
            white-space: pre-wrap;
            word-break: break-word;
            font: 13px/1.45 monospace;
            color: var(--rm-fg);
        `;

        head.appendChild(title);
        head.appendChild(closeBtn);
        card.appendChild(head);
        card.appendChild(body);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        const close = () => {
            overlay.style.display = 'none';
        };

        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });

        return overlay;
    }

    function showTextModal(title, text) {
        const overlay = ensureTextModal();
        const titleEl = overlay.querySelector('#release-text-modal-title');
        const bodyEl = overlay.querySelector('#release-text-modal-body');
        titleEl.textContent = title;
        bodyEl.textContent = text || 'Нет данных.';
        overlay.style.display = 'flex';
    }

    function getAiCell(row) {
        const cells = row.querySelectorAll('td');
        return cells.length >= 9 ? cells[8] : null;
    }

    function createLyricsIconButton() {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'release-ai-lyrics-btn';
        btn.title = 'Открыть текст песни';
        btn.style.cssText = `
            border: none;
            background: transparent;
            padding: 0;
            cursor: pointer;
            line-height: 0;
        `;
        btn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" style="color:var(--rm-link);">
                <path fill="currentColor" d="M4,2H14L20,8V12H18V9H13V4H6V20H13V22H4V2M6,11H16V13H6V11M6,15H16V17H6V15M6,7H11V9H6V7Z"></path>
                <path fill="currentColor" d="M17,12V17.17C16.69,17.06 16.35,17 16,17C14.9,17 14,17.67 14,18.5C14,19.33 14.9,20 16,20C17.1,20 18,19.33 18,18.5V14H21V17.17C20.69,17.06 20.35,17 20,17C18.9,17 18,17.67 18,18.5C18,19.33 18.9,20 20,20C21.1,20 22,19.33 22,18.5V12H17Z"></path>
            </svg>
        `;
        return btn;
    }

    function ensureAnalyzerStyles() {
        if (document.getElementById('release-ai-analyzer-styles')) return;
        const style = document.createElement('style');
        style.id = 'release-ai-analyzer-styles';
        style.textContent = `
            .release-ai-spinner {
                display:inline-block; width:16px; height:16px;
                border:2px solid var(--rm-muted-strong); border-top-color:var(--rm-link);
                border-radius:50%; animation:release-ai-spin .7s linear infinite;
            }
            @keyframes release-ai-spin { to { transform:rotate(360deg); } }
        `;
        document.head.appendChild(style);
    }

    const ANALYZER_ICONS = {
        ok: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#16a34a" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.1 14.6-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z"/></svg>',
        violation: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#dc2626" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
        lyrics: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#d97706" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
        error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="#9ca3af" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
    };

    // Уровень риска: русские подписи + единый акцентный цвет.
    const RISK = {
        none:   { word: 'нет',     color: '#16a34a' },
        low:    { word: 'низкий',  color: '#d97706' },
        medium: { word: 'средний', color: '#ea580c' },
        high:   { word: 'высокий', color: '#dc2626' },
    };

    // Подача (overall_framing) короткими русскими словами.
    const FRAMING = {
        'пропаганда': 'пропаганда',
        'романтизация': 'романтизация',
        'нейтральное_изображение': 'нейтральная',
        'осуждение': 'осуждение',
        'неприменимо': '',
    };

    // Проверка корректности текста (lyrics_check с сервера): что именно не так.
    const LYRICS_ISSUE = {
        'не_текст': 'Заметка вместо текста',
        'описание': 'Описание вместо текста',
        'таймкоды': 'Таймкоды',
        'расшифровка': 'Автоматическая расшифровка',
        'мусор': 'Не текст песни',
        'другое': 'Другое',
    };

    const lyricsInvalid = (data) => data?.lyrics_check?.status === 'invalid';

    function analyzerStateOf(data) {
        if (data?.verdict === 'violation') return 'violation';
        return lyricsInvalid(data) ? 'lyrics' : 'ok';
    }

    function setAnalyzerState(btn, state, data) {
        btn.dataset.state = state;
        if (state === 'loading') {
            btn.disabled = true;
            btn.title = 'ИИ проверяет текст…';
            btn.innerHTML = '<span class="release-ai-spinner"></span>';
            return;
        }
        btn.disabled = false;
        if (state === 'ok') {
            btn.title = 'Проверено ИИ: нарушений нет' + (data?.cached ? ' · из кеша' : '');
            btn.innerHTML = ANALYZER_ICONS.ok;
        } else if (state === 'violation') {
            const r = RISK[data?.severity];
            btn.title = `Проверено ИИ: есть замечания · риск ${r?.word || data?.severity || '—'}` +
                (lyricsInvalid(data) ? ' · текст некорректный' : '');
            btn.innerHTML = ANALYZER_ICONS.violation;
        } else if (state === 'lyrics') {
            const issue = data.lyrics_check.issues?.[0];
            btn.title = 'Проверено ИИ: текст некорректный' + (issue ? ` · ${LYRICS_ISSUE[issue.type] || issue.type}` : '');
            btn.innerHTML = ANALYZER_ICONS.lyrics;
        } else {
            btn.title = 'Ошибка проверки (клик — повторить): ' + (data || '');
            btn.innerHTML = ANALYZER_ICONS.error;
        }
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function ensureAnalysisModal() {
        let overlay = document.getElementById('release-analysis-modal');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'release-analysis-modal';
        overlay.style.cssText = `
            position: fixed; inset: 0; background: rgba(17,24,39,0.32);
            z-index: 1000001; display: none; align-items: center;
            justify-content: center; padding: 20px;
            -webkit-font-smoothing: antialiased;
        `;

        const card = document.createElement('div');
        card.style.cssText = `
            width: min(540px, 94vw); max-height: 86vh; overflow: hidden;
            background: #fff; border-radius: 14px;
            box-shadow: 0 12px 44px rgba(17,24,39,0.18);
            display: flex; flex-direction: column;
            font-family: var(--rm-font);
            color: var(--rm-fg);
        `;

        const head = document.createElement('div');
        head.id = 'release-analysis-head';
        head.style.cssText =
            'display:flex; justify-content:space-between; align-items:center; gap:12px; padding:18px 22px 14px;';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '✕';
        closeBtn.style.cssText =
            'border:none; background:none; padding:2px 4px; cursor:pointer; font-size:16px; color:var(--rm-subtle); line-height:1; flex:none;';
        closeBtn.addEventListener('mouseenter', () => (closeBtn.style.color = '#4b5563'));
        closeBtn.addEventListener('mouseleave', () => (closeBtn.style.color = '#9ca3af'));

        const body = document.createElement('div');
        body.id = 'release-analysis-body';
        body.style.cssText = 'padding:0 22px 24px; overflow:auto;';

        head.appendChild(closeBtn);
        card.appendChild(head);
        card.appendChild(body);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        const close = () => { overlay.style.display = 'none'; };
        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display === 'flex') close();
        });

        return overlay;
    }

    const LABEL_STYLE =
        'font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--rm-subtle);';

    function buildAnalysisHtml(data) {
        if (!data) return '<p style="color:var(--rm-subtle);">Нет данных.</p>';
        if (data.error) {
            return `<div style="font-size:15px; font-weight:600; color:var(--rm-destructive); margin-bottom:6px;">Ошибка проверки</div>
                <div style="font-size:13.5px; line-height:1.6; color:var(--rm-muted-fg);">${escapeHtml(data.error)}</div>
                <div style="font-size:12.5px; color:var(--rm-subtle); margin-top:10px;">Закройте окно и нажмите на иконку ещё раз, чтобы повторить.</div>`;
        }

        const isViol = data.verdict === 'violation';
        const badText = lyricsInvalid(data);
        const sevKey = data.severity || (isViol ? 'medium' : 'none');
        const risk = RISK[sevKey] || RISK.none;
        const accent = isViol ? risk.color : '#16a34a';
        const statusText = isViol ? 'Есть замечания' : badText ? 'Текст некорректный' : 'Нарушений нет';
        const statusColor = isViol ? accent : badText ? '#d97706' : accent;

        // Статус
        let html = `<div style="display:flex; align-items:center; gap:9px; margin-bottom:10px;">
            <span style="width:9px; height:9px; border-radius:50%; background:${statusColor}; flex:none;"></span>
            <span style="font-size:16px; font-weight:600; color:var(--rm-fg);">${statusText}</span>
        </div>`;

        // Мета-строка: риск · подача · кеш
        const meta = [];
        if (isViol) {
            meta.push(`Риск: <span style="color:${risk.color}; font-weight:600;">${risk.word}</span>`);
        }
        const framing = FRAMING[data.overall_framing];
        if (framing) meta.push(`Подача: ${escapeHtml(framing)}`);
        if (data.lyrics_check) {
            meta.push(badText
                ? '<span style="color:#b45309; font-weight:600;">Текст: некорректный</span>'
                : 'Текст: корректный');
        }
        if (data.cached) meta.push('из кеша');
        if (meta.length) {
            html += `<div style="font-size:13px; color:var(--rm-muted-fg); margin-bottom:18px;">
                ${meta.join('<span style="color:var(--rm-muted-strong); margin:0 8px;">·</span>')}
            </div>`;
        } else {
            html += '<div style="height:8px;"></div>';
        }

        // Корректность текста — первым блоком: без нормального текста дальше смотреть нет смысла.
        if (badText) {
            const issues = data.lyrics_check.issues || [];
            html += `<div style="margin:0 0 20px; padding:14px 16px; border:1px solid #fde68a; border-radius:10px; background:#fffbeb;">
                <div style="font-size:14px; font-weight:600; color:#92400e; margin-bottom:${issues.length ? '10px' : '0'};">Это не похоже на текст песни</div>
                ${issues.map((it) => `<div style="margin-top:10px;">
                    <div style="${LABEL_STYLE} color:#b45309; margin-bottom:6px;">${escapeHtml(LYRICS_ISSUE[it.type] || it.type || 'Другое')}</div>
                    ${it.fragment ? `<div style="border-left:2px solid #f59e0b; padding-left:10px; font-size:13.5px; line-height:1.5; color:var(--rm-fg); margin-bottom:6px;">${escapeHtml(it.fragment)}</div>` : ''}
                    ${it.reason ? `<div style="font-size:13px; line-height:1.55; color:#92400e;">${escapeHtml(it.reason)}</div>` : ''}
                </div>`).join('')}
            </div>`;
        }

        // Итог
        if (data.summary) {
            html += `<p style="font-size:14.5px; line-height:1.6; color:var(--rm-fg-soft); margin:0 0 20px;">${escapeHtml(data.summary)}</p>`;
        }

        // Контекст
        if (data.track_context) {
            html += `<div style="border-top:1px solid var(--rm-border-soft); padding-top:16px; margin-bottom:20px;">
                <div style="${LABEL_STYLE} margin-bottom:6px;">Контекст</div>
                <p style="font-size:13.5px; line-height:1.6; color:var(--rm-fg-soft); margin:0;">${escapeHtml(data.track_context)}</p>
            </div>`;
        }

        // Замечания
        const viols = Array.isArray(data.violations) ? data.violations : [];
        if (viols.length) {
            html += `<div style="border-top:1px solid var(--rm-border-soft); padding-top:16px;">
                <div style="${LABEL_STYLE} margin-bottom:14px;">Замечания · ${viols.length}</div>`;
            viols.forEach((v, i) => {
                const last = i === viols.length - 1;
                const cat = (v.category || 'другое');
                const basis = v.basis === 'общий_контекст'
                    ? '<span style="color:var(--rm-subtle);"> · по контексту</span>'
                    : '';
                html += `<div style="${last ? '' : 'padding-bottom:16px; margin-bottom:16px; border-bottom:1px solid var(--rm-border-soft);'}">
                    <div style="${LABEL_STYLE} margin-bottom:8px;">${escapeHtml(cat)}${basis}</div>
                    <div style="border-left:2px solid ${accent}; padding-left:12px; font-size:14.5px; line-height:1.5; color:var(--rm-fg); margin-bottom:8px;">${escapeHtml(v.line || '—')}</div>
                    ${v.reason ? `<p style="font-size:13.5px; line-height:1.6; color:var(--rm-muted-fg); margin:0; padding-left:14px;">${escapeHtml(v.reason)}</p>` : ''}
                </div>`;
            });
            html += '</div>';
        }

        return html;
    }

    function showAnalysisModal(data) {
        const overlay = ensureAnalysisModal();
        const head = overlay.querySelector('#release-analysis-head');
        const body = overlay.querySelector('#release-analysis-body');

        const closeBtn = head.querySelector('button');
        head.innerHTML = '';
        const title = document.createElement('div');
        title.style.cssText = 'font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--rm-subtle);';
        title.textContent = 'Проверка текста ИИ';
        head.appendChild(title);
        head.appendChild(closeBtn);

        body.innerHTML = buildAnalysisHtml(data);
        overlay.style.display = 'flex';
    }

    function createAiAnalyzerButton(id) {
        ensureAnalyzerStyles();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'release-ai-analyze-btn';
        btn.dataset.trackId = id;
        btn.style.cssText = `
            border:none; background:transparent; padding:0; margin-left:6px;
            cursor:pointer; line-height:0; vertical-align:middle;
            display:inline-flex; align-items:center;
        `;
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const state = btn.dataset.state;
            if (state === 'loading') return;
            if (state === 'error') {
                analyzeAndRender(btn, id, true);
                return;
            }
            showAnalysisModal(btn._analysis);
        });
        return btn;
    }

    async function analyzeAndRender(btn, id, force = false) {
        setAnalyzerState(btn, 'loading');
        try {
            const details = await fetchDetails(id);
            const data = await analyzeLyrics(id, details.lyrics || '', force);
            btn._analysis = data;
            setAnalyzerState(btn, analyzerStateOf(data), data);
        } catch (err) {
            const msg = err.message || String(err);
            btn._analysis = { error: msg };
            setAnalyzerState(btn, 'error', msg);
        }
    }

    function enhanceAiColumn(row, id) {
        const aiCell = getAiCell(row);
        if (!aiCell) return;

        const statusIcon =
            aiCell.querySelector('i.material-icons') ||
            aiCell.querySelector('.material-icons') ||
            aiCell.querySelector('svg');

        if (statusIcon && !statusIcon.dataset.aiCommentBound) {
            statusIcon.dataset.aiCommentBound = '1';
            statusIcon.style.cursor = 'pointer';
            statusIcon.title = 'Открыть замечания AI';
            statusIcon.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                    const details = await fetchDetails(id);
                    showTextModal('Замечания AI', details.aiComment || 'Замечаний AI нет.');
                } catch (err) {
                    showTextModal('Замечания AI', `Ошибка загрузки: ${err.message || err}`);
                }
            });
        }

        let actions = aiCell.querySelector('.release-ai-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'release-ai-actions';
            actions.style.cssText =
                'margin-top:6px; display:flex; justify-content:center; align-items:center; gap:6px;';
            aiCell.appendChild(actions);
        }

        if (!actions.querySelector('.release-ai-lyrics-btn')) {
            const lyricsBtn = createLyricsIconButton();
            lyricsBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                try {
                    const details = await fetchDetails(id);
                    showTextModal('Текст песни', details.lyrics || 'Текст песни отсутствует.');
                } catch (err) {
                    showTextModal('Текст песни', `Ошибка загрузки: ${err.message || err}`);
                }
            });
            actions.appendChild(lyricsBtn);
        }
    }

    async function renderReleaseInfo(form, id) {
        const row = form.closest('tr');
        if (!row) return;

        renderCommentsLoading(row, true);
        renderDetailsSkeleton(row);

        try {
            const [details, comments] = await Promise.all([
                fetchDetails(id),
                fetchComments(id),
            ]);

            renderDetails(row, details);
            renderComments(row, comments, true);
            enhanceAiColumn(row, id);

            form.dataset.detailsLoaded = '1';
        } catch (e) {
            removeSkeletons(row);
            enhanceAiColumn(row, id);
            renderCommentsError(row, true, e.message, () => renderReleaseInfo(form, id));
        }
    }

    function processForms() {
        const forms = Array.from(document.querySelectorAll('form')).filter(
            (f) => f.querySelector('input[name="audio_id"]') && f.querySelector('input[name="add_queue"]')
        );

        forms.forEach((f) => {
            if (f.dataset.detailsLoaded) return;
            const id = f.querySelector('input[name="audio_id"]')?.value;
            if (!id) return;

            f.dataset.detailsLoaded = 'loading';
            renderReleaseInfo(f, id);
        });
    }

    /* =====================================================
                        АЛЬБОМЫ → КОММЕНТАРИИ
    ===================================================== */

    async function fetchAlbumComments(slug) {
        const key = `album:${slug}`;
        return fetchParsed({
            url: `https://rumedia.io/media/album/${slug}`,
            cache: STATE.commentsCache,
            key,
            parser: parseComments,
        });
    }

    function getAlbumSlug(row) {
        const link = row.querySelector('a[href*="/album/"]');
        const href = link?.getAttribute('href') || '';
        const match = href.match(/\/album\/([^/?#]+)/i);
        return match?.[1] || null;
    }

    function getAlbumEditId(row) {
        const link = row.querySelector('a[href*="edit-album/"]');
        const href = link?.getAttribute('href') || '';
        const match = href.match(/edit-album\/([A-Za-z0-9]+)/i);
        return match?.[1] || null;
    }

    async function fetchAlbumInfo(editId) {
        return fetchParsed({
            url: `https://rumedia.io/media/edit-album/${editId}`,
            cache: STATE.aiArtworkCache,
            key: `album:${editId}`,
            parser: parseAlbumInfo,
            fallback: { aiUsed: null, artists: '', written: '', releaseDate: '', apple: null, trackCount: null },
        });
    }

    function processAlbumRows() {
        if (!location.pathname.includes('/admin-cp/manage-albums')) return;

        const rows = Array.from(document.querySelectorAll('.table-responsive1 tbody tr[id]'));

        rows.forEach((row) => {
            if (row.dataset.albumCommentsLoaded) return;

            const slug = getAlbumSlug(row);
            if (!slug) return;

            row.dataset.albumCommentsLoaded = 'loading';
            loadAlbumRow(row, slug, getAlbumEditId(row));
        });
    }

    function loadAlbumRow(row, slug, editId) {
        addAlbumQueueButton(row, editId);
        renderCommentsLoading(row, false);
        if (editId) renderAlbumInfoSkeleton(row);

        const infoPromise = editId
            ? fetchAlbumInfo(editId)
            : Promise.resolve({ aiUsed: null, artists: '', written: '', releaseDate: '', apple: null, trackCount: null });

        Promise.all([fetchAlbumComments(slug), infoPromise])
            .then(([comments, info]) => {
                renderAlbumInfo(row, info);
                renderAlbumBlock(row, info?.tracks, comments);
                row.dataset.albumCommentsLoaded = '1';
            })
            .catch((e) => {
                removeSkeletons(row);
                renderCommentsError(row, false, e.message, () => loadAlbumRow(row, slug, editId));
            });
    }

    /* =====================================================
                        ZOOM COVER
    ===================================================== */

    function enableCoverZoom() {
        const overlay = document.createElement('div');
        overlay.id = 'cover-zoom-overlay';
        overlay.style = `
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.85);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 999999;
            cursor: zoom-out;
        `;

        const img = document.createElement('img');
        img.style = `
            max-width: 90%;
            max-height: 90%;
            border-radius: 8px;
            box-shadow: 0 0 20px rgba(0,0,0,0.5);
        `;

        overlay.appendChild(img);
        document.body.appendChild(overlay);

        overlay.addEventListener('click', () => (overlay.style.display = 'none'));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') overlay.style.display = 'none';
        });

        function bindCovers() {
            document.querySelectorAll('img').forEach((i) => {
                if (i.dataset.zoomBound) return;
                i.dataset.zoomBound = '1';
                i.style.cursor = 'zoom-in';

                i.addEventListener('click', () => {
                    const src = i.src || i.getAttribute('data-src');
                    if (!src) return;
                    img.src = src;
                    overlay.style.display = 'flex';
                });
            });
        }

        bindCovers();
        new MutationObserver(() => {
            bindCovers();
            removeZvonkoButtons();
            styleQueueButtons();
        }).observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    /* =====================================================
               ДОБАВЛЕНИЕ АВТОРА И ПРОДЮСЕРА В EDIT-ALBUM
    ===================================================== */

    function getTrackIdFromLink(a) {
        if (!a) return null;
        const href = a.getAttribute('href') || '';
        const m = href.match(/edit-track\/([A-Za-z0-9]+)/);
        return m ? m[1] : null;
    }

    async function fetchTrackAuthors(id) {
        if (STATE.authorsCache.has(id)) return STATE.authorsCache.get(id);

        try {
            const details = await fetchDetails(id);
            const info = {
                written: details.written || '—',
                producer: details.producer || '—',
            };
            STATE.authorsCache.set(id, info);
            return info;
        } catch (_) {
            return null;
        }
    }

    async function enhanceAlbumEditor() {
        if (!location.pathname.includes('/media/edit-album/')) return;

        const blocks = document.querySelectorAll('.uploaded_albm_slist');

        for (const block of blocks) {
            if (block.dataset.authorsLoaded) continue;
            block.dataset.authorsLoaded = '1';

            const p = block.querySelector('p');
            if (!p) continue;

            const link =
                block.querySelector('a[data-load]') ||
                block.querySelector('a[href*="edit-track"]');

            const id = getTrackIdFromLink(link);
            if (!id) continue;

            if (link && !link.parentElement.querySelector('.release-ai-lyrics-btn')) {
                const lyricsBtn = createLyricsIconButton();
                lyricsBtn.style.marginLeft = '6px';
                lyricsBtn.style.verticalAlign = 'middle';
                lyricsBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    try {
                        const details = await fetchDetails(id);
                        showTextModal('Текст песни', details.lyrics || 'Текст песни отсутствует.');
                    } catch (err) {
                        showTextModal('Текст песни', `Ошибка загрузки: ${err.message || err}`);
                    }
                });
                link.insertAdjacentElement('afterend', lyricsBtn);

                const analyzeBtn = createAiAnalyzerButton(id);
                lyricsBtn.insertAdjacentElement('afterend', analyzeBtn);
                analyzeAndRender(analyzeBtn, id);
            }

            const info = await fetchTrackAuthors(id);
            if (!info) continue;

            const vocalSpan = [...p.querySelectorAll('span')].find((sp) =>
                sp.textContent.trim().startsWith('Вокал')
            );

            if (!vocalSpan) continue;

            const div = document.createElement('div');
            div.style.cssText = 'font-size:12px; margin-top:4px;';
            div.innerHTML = `
                <div>Автор: <b>${info.written}</b></div>
                <div>Продюсер: <b>${info.producer}</b></div>
            `;

            vocalSpan.insertAdjacentElement('afterend', div);
        }
    }

    /* =====================================================
              РЕДИЗАЙН СТРАНИЦЫ АЛЬБОМОВ (минимализм)
    ===================================================== */

    function isAlbumsListPage() {
        return location.pathname.includes('/admin-cp/manage-albums');
    }

    /*RM_CSS_START*/
    const RM_CSS = `
        body.rm-redesign {
            background:var(--rm-page) !important; color:var(--rm-fg);
            font-family:var(--rm-font) !important;
        }
        body.rm-redesign .navbar,
        body.rm-redesign #leftsidebar,
        body.rm-redesign .overlay,
        body.rm-redesign .block-header,
        body.rm-redesign .rm-filters,
        body.rm-redesign .table-responsive1 thead { display:none !important; }

        body.rm-redesign section.content { margin:0 !important; padding:20px 28px 64px !important; }
        body.rm-redesign section.content > .container-fluid { padding:0 !important; max-width:none; margin:0 !important; }
        body.rm-redesign .row { margin-left:0 !important; margin-right:0 !important; }
        body.rm-redesign .row > [class*="col-"] { padding-left:0 !important; padding-right:0 !important; }
        body.rm-redesign .card { background:transparent !important; box-shadow:none !important; margin-bottom:0 !important; }

        /* --- шапка --- */
        #rm-header { position:sticky; top:0; z-index:60; background:#fff; border-bottom:1px solid var(--rm-border); }
        .rm-header__inner { padding:0 28px; height:56px; display:flex; align-items:center; gap:4px; }
        .rm-tabs { display:flex; gap:4px; height:100%; }
        .rm-tabs a { display:flex; align-items:center; gap:8px; height:100%; padding:0 12px; font-size:14px;
            color:var(--rm-muted-fg) !important; text-decoration:none !important; border-bottom:2px solid transparent; }
        .rm-tabs a svg { color:var(--rm-subtle); }
        .rm-tabs a:hover { color:var(--rm-fg) !important; }
        .rm-tabs a.is-active { color:var(--rm-fg) !important; border-bottom-color:var(--rm-fg); font-weight:600; }
        .rm-tabs a.is-active svg { color:var(--rm-fg); }
        .rm-user { margin-left:auto; font-size:13px; color:var(--rm-muted-fg); white-space:nowrap; }
        .rm-user b { color:var(--rm-fg); font-weight:600; }

        /* --- переключатель очередей --- */
        .rm-seg { margin-left:auto; display:inline-flex; gap:2px; background:var(--rm-muted); border-radius:10px; padding:3px; }
        .rm-seg a { display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:8px;
            font-size:13px; font-weight:500; color:var(--rm-fg-soft) !important; text-decoration:none !important;
            border:none !important; background:transparent !important; white-space:nowrap; }
        .rm-seg a:hover { color:var(--rm-fg) !important; }
        .rm-seg a.is-active { background:#fff !important; color:var(--rm-fg) !important; box-shadow:0 1px 2px rgba(17,24,39,.1); }
        .rm-count { min-width:20px; padding:0 7px; border-radius:999px; text-align:center;
            font-size:12px; font-weight:600; line-height:18px; color:#fff; background:var(--rm-fg); }
        .rm-seg a:not(.is-active) .rm-count { background:var(--rm-muted-strong); color:var(--rm-fg-soft); }
        .rm-count.is-loading { opacity:.6; }

        /* --- скелетоны загрузки --- */
        @keyframes rm-skel { 0% { background-position:100% 50%; } 100% { background-position:0 50%; } }
        .rm-skel { display:inline-block; height:12px; max-width:100%; border-radius:6px; vertical-align:middle;
            background:linear-gradient(90deg, #eceef1 25%, #f6f7f9 37%, #eceef1 63%); background-size:400% 100%;
            animation:rm-skel 1.4s ease infinite; }
        .rm-skel--sm { height:9px; }
        .rm-skel--btn { display:block; height:32px; border-radius:8px; }
        .rm-skel-fields .rai-label { color:var(--rm-subtle); }
        .rm-skel-fields .rai-value { min-height:20px; display:flex; align-items:center; }
        body.rm-redesign .rm-skel-comments li { border-left-color:var(--rm-border-soft) !important; }
        body.rm-redesign .rm-skel-comments li > div { margin-top:7px !important; }
        body.rm-redesign .rm-seg a .rm-count.is-loading { display:inline-block; width:22px; min-width:22px; height:18px; padding:0; opacity:1; color:transparent;
            background:linear-gradient(90deg, var(--rm-muted-strong) 25%, var(--rm-border-soft) 37%, var(--rm-muted-strong) 63%) !important; background-size:400% 100% !important;
            animation:rm-skel 1.4s ease infinite; }
        @media (prefers-reduced-motion: reduce) {
            .rm-skel, body.rm-redesign .rm-seg a .rm-count.is-loading { animation:none; }
        }

        /* --- полоса очереди --- */
        body.rm-redesign .rm-queue-card { background:#fff !important; border:1px solid var(--rm-border); border-radius:12px; padding:14px 18px; }
        body.rm-redesign .rm-queue-card .header { padding:0 !important; border:none !important; background:none !important; }
        body.rm-redesign .rm-queue-card .header h2 { margin:0 !important; font-size:14px !important; font-weight:500 !important;
            color:var(--rm-fg-soft) !important; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        body.rm-redesign .rm-queue-card .header h2 > a { cursor:pointer; font-size:13px; font-weight:500; color:var(--rm-fg) !important;
            border:1px solid var(--rm-border); border-radius:8px; padding:4px 12px; background:#fff; text-decoration:none !important; }
        body.rm-redesign .rm-queue-card .header h2 > a:hover { background:var(--rm-accent); }
        body.rm-redesign .rm-queue-card #queue { padding:12px 0 0 !important; font-size:13px; }
        body.rm-redesign .rm-queue-card #queue button,
        body.rm-redesign .rm-queue-card #queue input[type="submit"] { font-size:13px; border:1px solid var(--rm-border); background:#fff;
            border-radius:8px; padding:6px 12px; color:var(--rm-fg); }
        body.rm-redesign .rm-queue-card #queue a { color:var(--rm-link) !important; }
        body.rm-redesign .rm-queue-card #queue table { margin:10px 0 !important; font-size:13px; }

        /* --- список релизов --- */
        body.rm-redesign .rm-list-card .body { padding:0 !important; background:transparent !important; }
        body.rm-redesign .table-responsive1 { overflow:visible !important; border:none !important; }
        body.rm-redesign .table-responsive1 table { display:block; border:none !important; background:transparent !important; margin:0 !important; }
        body.rm-redesign .table-responsive1 tbody { display:block; }
        body.rm-redesign .table-responsive1 tbody > tr { background:transparent !important; }
        body.rm-redesign .table-responsive1 tbody > tr > td { border:none !important; padding:0 !important;
            background:transparent !important; vertical-align:top !important; }

        body.rm-albums .table-responsive1 tr[id] {
            display:grid; grid-template-columns:140px minmax(0,1fr) 190px; column-gap:24px; align-items:start;
            padding:20px !important; margin-top:14px; background:#fff !important;
            border:1px solid var(--rm-border); border-bottom:none; border-radius:14px 14px 0 0;
        }
        body.rm-albums .table-responsive1 tr[id]:not(:has(+ tr.release-comments-row)) { border-bottom:1px solid var(--rm-border); border-radius:14px; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(1),
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(3),
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(5),
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(6),
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(7),
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(8) { display:none !important; }
        body.rm-albums .table-responsive1 tr[id] > td { display:block; min-width:0; font-size:13.5px; color:var(--rm-fg); }

        body.rm-albums .table-responsive1 tr[id] > td:nth-child(2) img { width:140px !important; height:140px !important;
            object-fit:cover; border-radius:10px; margin:0 !important; display:block !important; }

        /* основная часть карточки */
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(4) > p { margin:0 !important; font-size:17px; font-weight:600;
            line-height:1.3; color:var(--rm-fg); }
        .rm-meta { display:flex; align-items:center; flex-wrap:wrap; gap:4px 10px; margin-top:8px; font-size:13px; color:var(--rm-muted-fg); }
        .rm-meta .rm-sep { color:var(--rm-muted-strong); }
        .rm-artist { display:inline-flex; align-items:center; gap:7px; color:var(--rm-fg) !important; font-weight:500;
            text-decoration:none !important; }
        .rm-artist:hover span { text-decoration:underline; }
        .rm-artist img { width:22px; height:22px; border-radius:50%; object-fit:cover; flex:none; }
        .rm-badge { font-size:11px; font-weight:600; color:#b45309; background:#fef3c7; border-radius:5px; padding:1px 6px; }
        .rm-stats { display:flex; flex-wrap:wrap; gap:4px 16px; margin-top:8px; }
        .rm-stat { font-size:12.5px; color:var(--rm-muted-fg); display:inline-flex; align-items:center; gap:7px; }
        .rm-stat::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--rm-muted-strong); flex:none; }
        .rm-stat--green::before { background:var(--rm-success); }
        .rm-stat--red { color:var(--rm-destructive); }
        .rm-stat--red::before { background:var(--rm-destructive); }
        .rm-stat--orange::before { background:#f59e0b; }

        body.rm-albums .table-responsive1 tr[id] > td:nth-child(4) > small { display:block; margin-top:10px; padding:8px 10px;
            border-radius:8px; background:#fffbeb; color:#92400e; font-size:12.5px; line-height:1.45; }

        .release-album-info { display:inline-flex; flex-wrap:wrap; max-width:100%; margin-top:16px; border:1px solid var(--rm-border-soft); border-radius:10px; }
        .rai-field { padding:10px 16px; border-right:1px solid var(--rm-border-soft); min-width:0; }
        .rai-field:last-child { border-right:none; }
        .rai-label { margin-bottom:4px; font-size:10.5px; font-weight:600; letter-spacing:.08em; text-transform:uppercase;
            color:var(--rm-subtle); white-space:nowrap; }
        .rai-value { font-size:14px; font-weight:500; color:var(--rm-fg); line-height:1.4; }
        .rai-value svg { vertical-align:-2px; }
        .rm-artists { display:inline-flex; align-items:center; flex-wrap:wrap; gap:4px 7px; }
        .rm-feat { display:inline-flex; align-items:center; height:20px; padding:0 7px; border-radius:var(--rm-radius-sm);
            border:1px solid #bfdbfe; background:#eff6ff; color:#1d4ed8; font-size:11.5px; font-weight:600; letter-spacing:.01em; cursor:help; }
        .rm-feat-names { color:#1d4ed8; }
        .rm-author { display:inline-flex; align-items:center; gap:5px; color:#92400e; }
        .rm-author-warn { display:inline-flex; align-items:center; justify-content:center; width:17px; height:17px; border-radius:50%;
            background:#fef3c7; color:#b45309; font-size:11px; font-weight:700; cursor:help; }
        .rm-author-hints { margin-top:6px; display:flex; flex-direction:column; gap:3px; }
        .rm-author-hint { font-size:12px; line-height:1.35; font-weight:500; color:#b45309; }
        .rm-author-hint b { font-weight:600; }

        /* действия */
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) { display:flex !important; flex-direction:column; gap:8px; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) br { display:none; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .btn,
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .release-queue-btn {
            display:block !important; width:100%; margin:0 !important; float:none !important; text-align:center;
            font-size:13px !important; font-weight:500 !important; line-height:1.3 !important; text-transform:none !important;
            padding:8px 12px !important; border-radius:8px !important; box-shadow:none !important;
        }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .btn-default {
            background:#fff !important; color:var(--rm-fg) !important; border:1px solid var(--rm-border) !important; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .btn-default:hover { background:var(--rm-accent) !important; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .btn-danger {
            background:#fff !important; color:var(--rm-destructive) !important; border:1px solid var(--rm-destructive-border) !important; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .btn-danger:hover { background:var(--rm-destructive-bg) !important; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .release-queue-btn {
            background:var(--rm-success) !important; color:#fff !important; border:1px solid var(--rm-success) !important; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .release-queue-btn:hover { background:var(--rm-success-hover) !important; }

        /* нижняя часть карточки: треки + комментарии */
        body.rm-redesign .table-responsive1 tr.release-comments-row { display:block; background:#fff !important;
            border:1px solid var(--rm-border); border-top:1px solid var(--rm-border-soft); border-radius:0 0 14px 14px; }
        body.rm-redesign .table-responsive1 tr.release-comments-row > td { display:block !important;
            padding:14px 20px 18px !important; background:transparent !important; border:none !important; }

        body.rm-redesign .release-tracks-toggle { background:#fff !important; color:var(--rm-fg) !important;
            border:1px solid var(--rm-border) !important; border-radius:8px !important; box-shadow:none !important;
            padding:7px 12px !important; font-size:13px !important; }
        body.rm-redesign .release-tracks-toggle:hover { background:var(--rm-accent) !important; }
        body.rm-redesign .release-tracks-toggle .release-tracks-count { background:var(--rm-muted) !important; color:var(--rm-fg-soft) !important; }
        body.rm-redesign .release-track-card { background:var(--rm-muted-soft) !important; border-color:var(--rm-border-soft) !important; }

        body.rm-redesign .release-album-tracks + .release-inline-comments { border-top:1px solid var(--rm-border-soft); padding-top:14px; }
        body.rm-redesign .release-inline-comments h4 { font-size:10.5px !important; font-weight:600 !important; letter-spacing:.08em;
            text-transform:uppercase; color:var(--rm-subtle) !important; margin:2px 0 10px !important; }
        body.rm-redesign .release-inline-comments ul { list-style:none; padding:0 !important; margin:0 !important;
            display:flex; flex-direction:column; gap:10px; }
        body.rm-redesign .release-inline-comments li { margin:0 !important; padding-left:12px; border-left:2px solid var(--rm-border);
            font-size:13px; line-height:1.55 !important; color:var(--rm-fg-soft); }
        body.rm-redesign .release-inline-comments li strong { color:var(--rm-fg); }
        body.rm-redesign .release-inline-comments li > div { margin-top:3px; font-size:11.5px !important; color:var(--rm-subtle) !important; }
        body.rm-redesign .release-inline-comments p { font-size:13px; color:var(--rm-subtle); margin:0; }

        /* пагинация не нужна — количество показывается в боковом меню */
        body.rm-redesign .table-responsive1 > .pull-left,
        body.rm-redesign .table-responsive1 > .pull-right { display:none !important; }


        /* --- рейтинг пользователя (+ N −) --- */
        body.rm-redesign .rm-rating { display:inline-flex; align-items:center; gap:3px; font-size:12.5px !important;
            color:var(--rm-muted-fg); white-space:nowrap; }
        body.rm-redesign .rm-rating::before { content:'Рейтинг'; margin-right:5px; }
        body.rm-redesign .rm-rating > a { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
            border:1px solid var(--rm-border); border-radius:6px; font-size:13px; line-height:1; color:var(--rm-fg-soft) !important;
            text-decoration:none !important; cursor:pointer; user-select:none; }
        body.rm-redesign .rm-rating > a:hover { background:var(--rm-accent); }
        body.rm-redesign .rm-rating > span[id^="rate-"] { min-width:18px; text-align:center; font-weight:600; color:var(--rm-fg); }
        .rm-stat--orange { color:#b45309; }

        /* --- полосы: очередь / задачи --- */
        body.rm-redesign .rm-queue-card + .rm-queue-card { margin-top:8px; }
        .rm-strip-actions { margin-left:auto; display:flex; align-items:center; gap:8px; }
        .rm-strip-actions form { margin:0; display:inline-flex; }
        body.rm-redesign .rm-strip-actions .btn,
        body.rm-redesign .rm-strip-actions input[type="submit"] { position:static !important; right:auto !important; margin:0 !important;
            font-size:13px !important; font-weight:500 !important; line-height:1.3 !important; text-transform:none !important;
            padding:5px 12px !important; border:1px solid var(--rm-border) !important; border-radius:8px !important;
            background:#fff !important; color:var(--rm-fg) !important; box-shadow:none !important; cursor:pointer; }
        body.rm-redesign .rm-strip-actions .btn:hover,
        body.rm-redesign .rm-strip-actions input[type="submit"]:hover { background:var(--rm-accent) !important; }
        body.rm-songs #crm { display:none !important; }

        /* --- задачи: входящие / исходящие --- */
        .rm-task-tab { display:inline-flex; align-items:center; gap:8px; padding:5px 10px 5px 12px; border:1px solid var(--rm-border);
            border-radius:8px; background:#fff; font:inherit; font-size:13px; font-weight:500; color:var(--rm-fg); cursor:pointer; }
        .rm-task-tab:hover { background:var(--rm-accent); }
        .rm-task-tab.is-open { background:var(--rm-fg); border-color:var(--rm-fg); color:#fff; }
        .rm-task-tab .rm-count { background:var(--rm-muted-strong); color:var(--rm-fg-soft); }
        .rm-task-tab.is-open .rm-count { background:rgba(255,255,255,.18); color:#fff; }
        .rm-task-tab svg { color:var(--rm-subtle); transition:transform .15s; }
        .rm-task-tab.is-open svg { color:#fff; transform:rotate(180deg); }
        .rm-tasks { padding-top:14px; }
        .rm-tasks-bar { display:flex; align-items:center; gap:8px; margin-bottom:10px; font-size:12.5px; color:var(--rm-muted-fg); }
        .rm-tasks-bar b { color:var(--rm-fg); font-weight:600; }
        .rm-tasks-nav { margin-left:auto; display:inline-flex; gap:6px; }
        .rm-tasks-nav[hidden] { display:none; }
        .rm-tasks-nav button { display:inline-flex; align-items:center; justify-content:center; width:30px; height:28px;
            border:1px solid var(--rm-border); border-radius:8px; background:#fff; color:var(--rm-fg); cursor:pointer; }
        .rm-tasks-nav button:hover:not(:disabled) { background:var(--rm-accent); }
        .rm-tasks-nav button:disabled { opacity:.35; cursor:default; }
        .rm-tasks-grid { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:10px; }
        .rm-task { display:flex; flex-direction:column; gap:6px; min-width:0; padding:12px 14px; border:1px solid var(--rm-border-soft);
            border-radius:10px; background:var(--rm-muted-soft); }
        .rm-task[hidden] { display:none; }
        .rm-task-top { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--rm-muted-fg); }
        .rm-task-prio { display:inline-flex; align-items:center; gap:6px; font-weight:600; color:var(--rm-fg-soft); }
        .rm-task-prio::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--prio, var(--rm-subtle)); }
        .rm-task-date { margin-left:auto; white-space:nowrap; }
        .rm-task-title { font-size:14px; font-weight:600; line-height:1.35; color:var(--rm-fg); overflow-wrap:anywhere;
            display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
        .rm-task-text { font-size:12.5px; line-height:1.45; color:var(--rm-fg-soft); overflow-wrap:anywhere;
            display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-line; }
        .rm-task-who { font-size:12px; color:var(--rm-subtle); }
        .rm-task-open { margin-top:auto; padding:6px 12px; border:1px solid var(--rm-border); border-radius:8px; background:#fff;
            font:inherit; font-size:13px; font-weight:500; color:var(--rm-fg); cursor:pointer; }
        .rm-task-open:hover { background:var(--rm-accent); }
        .rm-tasks-empty { padding:6px 0 2px; font-size:13px; color:var(--rm-subtle); }

        /* --- синглы: карточка --- */
        .rm-title { margin:0 !important; font-size:17px; font-weight:600; line-height:1.3; color:var(--rm-fg); }
        .rm-extra { margin-top:10px; font-size:12.5px; line-height:1.45; color:#92400e; }
        .rm-audio audio { display:block; width:100%; max-width:420px; height:36px; margin-top:14px; }
        .rm-audio .rm-player { margin-top:14px; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) .rm-audio .rm-player { margin-top:0; }

        body.rm-songs .table-responsive1 tr[id] {
            display:grid; grid-template-columns:140px minmax(0,1fr) 190px;
            grid-template-areas:"cover main actions" "cover ai actions";
            column-gap:24px; align-items:start; padding:20px !important; margin-top:14px; background:#fff !important;
            border:1px solid var(--rm-border); border-bottom:none; border-radius:14px 14px 0 0;
        }
        body.rm-songs .table-responsive1 tr[id]:not(:has(+ tr:not([id]))) { border-bottom:1px solid var(--rm-border); border-radius:14px; }
        body.rm-songs .table-responsive1 tr[id] > td { display:block; min-width:0; font-size:13.5px; color:var(--rm-fg); }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(1),
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(3),
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(5),
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(6),
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(7),
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(8) { display:none !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(2) { grid-area:cover; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(2) img { width:140px !important; height:140px !important;
            object-fit:cover; border-radius:10px; margin:0 !important; display:block !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(4) { grid-area:main; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) { grid-area:ai; display:flex !important; align-items:center;
            gap:10px; margin-top:14px; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9)::before { content:'Проверка ИИ'; font-size:10.5px; font-weight:600;
            letter-spacing:.08em; text-transform:uppercase; color:var(--rm-subtle); }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) .release-ai-actions { margin:0 !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) { flex-wrap:wrap; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) .rm-audio { order:-1; flex:0 1 420px; min-width:240px; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) .rm-audio audio { margin-top:0; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9):has(.rm-audio)::before { margin-left:8px; padding-left:18px;
            border-left:1px solid var(--rm-border-soft); line-height:28px; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) i.material-icons { display:inline-flex; line-height:0; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) { grid-area:actions; display:flex !important; flex-direction:column; gap:8px; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) br { display:none; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) form { margin:0; }
        /* синглы: действия */
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) { display:flex !important; flex-direction:column; gap:8px; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) br { display:none; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .btn,
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .release-queue-btn {
            display:block !important; width:100%; margin:0 !important; float:none !important; text-align:center;
            font-size:13px !important; font-weight:500 !important; line-height:1.3 !important; text-transform:none !important;
            padding:8px 12px !important; border-radius:8px !important; box-shadow:none !important;
        }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .btn-default {
            background:#fff !important; color:var(--rm-fg) !important; border:1px solid var(--rm-border) !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .btn-default:hover { background:var(--rm-accent) !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .btn-danger {
            background:#fff !important; color:var(--rm-destructive) !important; border:1px solid var(--rm-destructive-border) !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .btn-danger:hover { background:var(--rm-destructive-bg) !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .release-queue-btn {
            background:var(--rm-success) !important; color:#fff !important; border:1px solid var(--rm-success) !important; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .release-queue-btn:hover { background:var(--rm-success-hover) !important; }


        /* синглы: распознание */
        body.rm-songs .table-responsive1 tr.rm-recog { display:grid; grid-template-columns:140px minmax(0,1fr);
            column-gap:24px; align-items:start; padding:16px 20px !important; background:#fff !important;
            border:1px solid var(--rm-border); border-top:1px solid var(--rm-border-soft); border-bottom:none; }
        body.rm-songs .table-responsive1 tr.rm-recog:not(:has(+ tr.release-comments-row)) { border-bottom:1px solid var(--rm-border);
            border-radius:0 0 14px 14px; }
        body.rm-songs .table-responsive1 tr.rm-recog > td { display:block; min-width:0; font-size:13px; color:var(--rm-fg-soft); }
        body.rm-songs .table-responsive1 tr.rm-recog > td:nth-child(1) { padding-top:5px !important; font-size:10.5px; font-weight:600;
            letter-spacing:.08em; text-transform:uppercase; color:var(--rm-subtle); }
        body.rm-songs .table-responsive1 tr.rm-recog > td:nth-child(n+3) { display:none !important; }
        .rm-rec-head { display:flex; align-items:center; gap:10px; }
        .rm-rec-pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px;
            font-size:12.5px; font-weight:600; background:var(--rm-accent); color:var(--rm-fg-soft); }
        .rm-rec-pill::before { content:''; width:6px; height:6px; border-radius:50%; background:currentColor; }
        .rm-rec-pill--warn { background:#fef3c7; color:#92400e; }
        .rm-rec-pill--ok { background:var(--rm-success-bg); color:var(--rm-success); }
        .rm-rec-pill--bad { background:var(--rm-destructive-bg); color:var(--rm-destructive); }
        .rm-rec-count { font-size:12.5px; color:var(--rm-subtle); }
        .rm-rec-list { margin-top:12px; border:1px solid var(--rm-border-soft); border-radius:10px; }
        .rm-rec-item { display:flex; align-items:center; gap:16px; padding:10px 14px; }
        .rm-rec-item + .rm-rec-item { border-top:1px solid var(--rm-border-soft); }
        .rm-rec-main { flex:1; min-width:0; }
        .rm-rec-title { font-size:13.5px; font-weight:600; color:var(--rm-fg); }
        .rm-rec-artist { font-weight:400; color:var(--rm-muted-fg); }
        .rm-rec-sub { margin-top:2px; font-size:12.5px; color:var(--rm-muted-fg); }
        .rm-rec-links { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
        .rm-rec-link { padding:3px 9px; border:1px solid var(--rm-border); border-radius:6px; background:#fff; white-space:nowrap;
            font-size:12px; font-weight:500; color:var(--rm-link) !important; text-decoration:none !important; }
        .rm-rec-link:hover { background:var(--rm-accent); }

        /* --- синглы: «Отклонить» и окно решения --- */
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .rm-reject-btn,
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .rm-reject-btn { display:block; width:100%; margin:0;
            padding:8px 12px; border:1px solid #fcd34d; border-radius:8px; background:#fff; color:#b45309;
            font-size:13px; font-weight:500; line-height:1.3; text-align:center; cursor:pointer; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .rm-reject-btn:hover,
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .rm-reject-btn:hover { background:#fffbeb; }
        .rm-modal-overlay { position:fixed; inset:0; z-index:1000002; display:flex; align-items:center; justify-content:center;
            padding:20px; background:rgba(17,24,39,.35);
            font-family:var(--rm-font); }
        .rm-modal { width:min(560px, 94vw); background:#fff; border-radius:14px; color:var(--rm-fg);
            box-shadow:0 20px 50px rgba(17,24,39,.2); }
        .rm-modal__head { padding:20px 22px 4px; }
        .rm-modal__title { font-size:16px; font-weight:700; }
        .rm-modal__sub { margin-top:3px; font-size:13px; color:var(--rm-muted-fg); }
        .rm-modal__body { padding:14px 22px 4px; }
        .rm-modal-seg { display:inline-flex; gap:2px; margin-bottom:14px; padding:3px; border-radius:10px; background:var(--rm-muted); }
        .rm-modal-seg button { border:none; background:transparent; padding:6px 14px; border-radius:8px;
            font-size:13px; font-weight:500; color:var(--rm-fg-soft); cursor:pointer; }
        .rm-modal-seg button.is-active { background:#fff; color:var(--rm-fg); box-shadow:0 1px 2px rgba(17,24,39,.1); }
        .rm-modal-seg button:disabled { cursor:default; }
        .rm-modal__prefix { padding:9px 12px; border:1px solid var(--rm-border-soft); border-bottom:none; border-radius:10px 10px 0 0;
            background:var(--rm-accent); font-size:13px; line-height:1.45; color:var(--rm-muted-fg); }
        .rm-modal textarea { display:block; width:100%; min-height:130px; box-sizing:border-box; resize:vertical;
            padding:10px 12px; border:1px solid var(--rm-border); border-radius:10px; outline:none;
            font:inherit; font-size:13.5px; line-height:1.5; color:var(--rm-fg); background:#fff; }
        .rm-modal__prefix + textarea { border-radius:0 0 10px 10px; }
        .rm-modal textarea:focus { border-color:var(--rm-subtle); }
        .rm-modal__status { min-height:18px; margin-top:10px; font-size:12.5px; color:var(--rm-muted-fg); }
        .rm-modal__status.is-error { color:var(--rm-destructive); }
        .rm-modal__foot { display:flex; justify-content:flex-end; gap:8px; padding:10px 22px 20px; }
        .rm-modal__foot button { padding:8px 14px; border:1px solid var(--rm-border); border-radius:8px; background:#fff;
            font-size:13px; font-weight:500; color:var(--rm-fg); cursor:pointer; }
        .rm-modal__foot .rm-modal__primary { border-color:transparent; background:var(--rm-destructive); color:#fff; }
        .rm-modal__foot .rm-modal__primary.is-rights { background:#d97706; }
        .rm-modal__foot .rm-modal__primary:disabled { opacity:.6; cursor:default; }

        /* --- порядок кнопок: Добавить в очередь → Отклонить → Редактировать → Удалить --- */
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .release-album-queue-btn { order:1; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .rm-reject-btn { order:2; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .btn-default { order:3; }
        body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) .btn-danger { order:4; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) > form { order:1; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .rm-reject-btn { order:2; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .btn-default { order:3; }
        body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) .btn-danger { order:4; }

        /* --- клише в окне решения --- */
        .rm-modal-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:14px; }
        .rm-modal-toolbar .rm-modal-seg { margin-bottom:0; }
        .rm-clishe-toggle { margin-left:auto; display:inline-flex; align-items:center; gap:6px; padding:6px 12px;
            border:1px solid var(--rm-border); border-radius:8px; background:#fff; font-size:13px; font-weight:500; color:var(--rm-fg); cursor:pointer; }
        .rm-clishe-toggle svg { color:var(--rm-muted-fg); }
        .rm-clishe-toggle:hover, .rm-clishe-toggle.is-open { background:var(--rm-accent); }
        .rm-clishe { margin-bottom:12px; border:1px solid var(--rm-border); border-radius:10px; overflow:hidden; background:#fff; }
        .rm-clishe-searchbar { display:flex; align-items:center; gap:8px; padding-right:12px;
            border-bottom:1px solid var(--rm-border-soft); background:var(--rm-muted-soft); }
        .rm-clishe-search { display:block; flex:1; min-width:0; box-sizing:border-box; padding:9px 12px; border:none;
            outline:none; background:transparent; font:inherit; font-size:13.5px; color:var(--rm-fg); }
        .rm-clishe-manage { flex:none; display:inline-flex; align-items:center; gap:4px; font-size:12.5px; font-weight:500;
            color:var(--rm-muted-fg); text-decoration:none; white-space:nowrap; }
        .rm-clishe-manage:hover { color:var(--rm-fg); text-decoration:underline; }
        .rm-clishe-list { max-height:240px; overflow:auto; }
        .rm-clishe-item { display:flex; align-items:flex-start; gap:10px; width:100%; padding:9px 12px; border:none;
            border-top:1px solid var(--rm-border-soft); background:#fff; text-align:left; font:inherit; cursor:pointer; }
        .rm-clishe-item:first-child { border-top:none; }
        .rm-clishe-item:hover { background:var(--rm-accent); }
        .rm-clishe-item.is-picked { background:var(--rm-accent); }
        .rm-clishe-mark { flex:none; display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px;
            margin-top:1px; border:1.5px solid var(--rm-muted-strong); border-radius:50%; font-size:11px; font-weight:700; color:#fff; }
        .rm-clishe-item.is-picked .rm-clishe-mark { background:var(--rm-fg); border-color:var(--rm-fg); }
        .rm-clishe-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
        .rm-clishe-text b { font-size:13.5px; font-weight:600; color:var(--rm-fg); }
        .rm-clishe-text span { font-size:12.5px; color:var(--rm-muted-fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .rm-clishe-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 12px;
            border-top:1px solid var(--rm-border-soft); background:var(--rm-muted-soft); font-size:12.5px; color:var(--rm-muted-fg); }
        .rm-clishe-insert { padding:6px 14px; border:none; border-radius:8px; background:var(--rm-fg); color:#fff;
            font-size:13px; font-weight:500; cursor:pointer; }
        .rm-clishe-insert:disabled { opacity:.35; cursor:default; }
        .rm-clishe-empty { display:flex; align-items:center; gap:8px; padding:16px 12px; font-size:13px; color:var(--rm-subtle); }
        .rm-clishe-empty.is-error { color:var(--rm-destructive); }
        .rm-clishe-retry { margin-left:auto; padding:3px 10px; border:1px solid var(--rm-border); border-radius:6px; background:#fff;
            font-size:12px; color:var(--rm-fg); cursor:pointer; }

        @media (max-width:1000px) {
            .rm-header__inner { padding:0 16px; }
            .rm-user { display:none; }
            body.rm-redesign section.content { padding:16px 16px 48px !important; }
            body.rm-albums .table-responsive1 tr[id] { grid-template-columns:72px minmax(0,1fr); row-gap:14px; }
            body.rm-albums .table-responsive1 tr[id] > td:nth-child(2) img { width:72px !important; height:72px !important; }
            body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) { grid-column:1 / -1; flex-direction:row; }
            .rm-seg { margin-left:0; }
            body.rm-songs .table-responsive1 tr[id] { grid-template-columns:72px minmax(0,1fr);
                grid-template-areas:"cover main" "ai ai" "actions actions"; row-gap:14px; }
            body.rm-songs .table-responsive1 tr[id] > td:nth-child(2) img { width:72px !important; height:72px !important; }
            body.rm-songs .table-responsive1 tr[id] > td:nth-child(10) { flex-direction:row; }
            body.rm-songs .table-responsive1 tr.rm-recog { grid-template-columns:1fr; row-gap:8px; }
            .rm-rec-item { flex-wrap:wrap; }
            .rm-rec-links { justify-content:flex-start; }
            .rm-tasks-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
        }


        /* --- панель «Отгрузка» --- */
        .rm-ship-badge { display:inline-flex; align-items:center; height:22px; margin-left:8px; padding:0 8px; border-radius:var(--rm-radius-sm);
            background:var(--rm-muted); font-size:12.5px; font-weight:500; color:var(--rm-fg-soft); vertical-align:middle; }
        .rm-ship-badge.is-warn { background:#fffbeb; color:#b45309; box-shadow:inset 0 0 0 1px #fde68a; }
        body.rm-redesign .rm-queue-card .rm-strip-text { font-weight:600; color:var(--rm-fg); }
        body.rm-redesign .rm-queue-card #queue { padding:16px 0 0 !important; }
        .rm-ship-bar { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
        .rm-ship-allform { margin:0 0 0 auto; display:inline-flex; }
        body.rm-redesign .rm-queue-card #queue .rm-ship-btn { display:inline-flex; align-items:center; gap:6px; height:32px;
            box-sizing:border-box; padding:0 12px; border:1px solid var(--rm-border); border-radius:var(--rm-radius-md);
            background:var(--rm-card); box-shadow:var(--rm-shadow-xs); font:inherit; font-size:13px; font-weight:500;
            color:var(--rm-fg) !important; text-decoration:none !important; cursor:pointer; white-space:nowrap; }
        body.rm-redesign .rm-queue-card #queue .rm-ship-btn:hover { background:var(--rm-accent); }
        body.rm-redesign .rm-queue-card #queue .rm-ship-btn.is-primary { background:var(--rm-primary); border-color:var(--rm-primary);
            color:var(--rm-primary-fg) !important; }
        body.rm-redesign .rm-queue-card #queue .rm-ship-btn.is-primary:hover { background:#262626; }
        body.rm-redesign .rm-queue-card #queue table.rm-ship-table { display:block; width:100%; margin:0 !important; border:1px solid var(--rm-border);
            border-radius:var(--rm-radius-lg); overflow:hidden; font-size:13px; background:var(--rm-card); }
        .rm-ship-table tbody { display:block; }
        .rm-ship-table tr { display:grid; grid-template-columns:170px minmax(0,1fr) auto auto; align-items:center; gap:14px;
            padding:9px 12px; background:transparent !important; }
        .rm-ship-table tr + tr { border-top:1px solid var(--rm-border-soft); }
        .rm-ship-table tr:hover { background:var(--rm-muted-soft) !important; }
        .rm-ship-table td { display:block; padding:0 !important; border:none !important; background:transparent !important; }
        .rm-ship-status { display:inline-flex; align-items:center; gap:7px; font-size:12.5px; font-weight:500; color:var(--rm-success); }
        .rm-ship-status::before { content:''; width:7px; height:7px; border-radius:50%; background:currentColor; flex:none; }
        .rm-ship-status.is-warn { color:#b45309; }
        .rm-ship-status.is-muted { color:var(--rm-muted-fg); }
        body.rm-redesign .rm-queue-card #queue .rm-ship-btn.is-success { background:var(--rm-success); border-color:var(--rm-success);
            color:#fff !important; }
        body.rm-redesign .rm-queue-card #queue .rm-ship-btn.is-success:hover { background:var(--rm-success-hover); }
        .rm-ship-kind { margin-right:8px; font-weight:500; color:var(--rm-fg); }
        .rm-ship-c-links { display:flex !important; gap:14px; }
        body.rm-redesign .rm-queue-card #queue a.rm-ship-link { font-size:13px; font-weight:500; color:var(--rm-fg-soft) !important;
            text-decoration:none !important; }
        body.rm-redesign .rm-queue-card #queue a.rm-ship-link:hover { color:var(--rm-fg) !important; text-decoration:underline !important; }
        body.rm-redesign .rm-queue-card #queue .rm-ship-btn.rm-ship-done { height:28px; padding:0 10px; }
        .rm-ship-empty { padding:14px 0 2px; font-size:13px; color:var(--rm-subtle); }

        /* =========================================================
           Тема shadcn/ui (new-york, neutral): токены + компоненты
           Button / Badge / Tabs / Input / Dialog / Card / Skeleton
        ========================================================= */
        body.rm-redesign { font-size:14px; -webkit-font-smoothing:antialiased; }
        body.rm-redesign ::selection { background:var(--rm-fg); color:#fff; }

        /* шапка — как у ui.shadcn.com: полупрозрачная, с размытием */
        #rm-header { background:rgb(255 255 255 / .85); backdrop-filter:saturate(1.8) blur(8px); -webkit-backdrop-filter:saturate(1.8) blur(8px); }
        .rm-tabs a { font-size:14px; font-weight:500; color:var(--rm-muted-fg) !important; transition:color .15s; }
        .rm-tabs a.is-active { font-weight:600; }
        .rm-user { font-size:13px; }

        /* Card */
        body.rm-redesign .rm-queue-card { border-radius:var(--rm-radius-xl); box-shadow:var(--rm-shadow-xs); }
        body.rm-albums .table-responsive1 tr[id], body.rm-songs .table-responsive1 tr[id],
        body.rm-redesign .table-responsive1 tr.release-comments-row, body.rm-songs .table-responsive1 tr.rm-recog {
            box-shadow:var(--rm-shadow-xs); }
        .rm-title { font-size:17px; font-weight:600; letter-spacing:-.01em; }
        .rai-label { font-size:11px; font-weight:500; letter-spacing:.04em; color:var(--rm-muted-fg); }
        .release-album-info { border-radius:var(--rm-radius-lg); }

        /* Tabs (переключатель очередей) */
        .rm-seg { background:var(--rm-muted); border-radius:var(--rm-radius-lg); padding:3px; }
        .rm-seg a { height:30px; padding:0 12px; border-radius:var(--rm-radius-md); font-size:14px; font-weight:500;
            color:var(--rm-muted-fg) !important; transition:color .15s, background .15s; }
        .rm-seg a.is-active { color:var(--rm-fg) !important; box-shadow:var(--rm-shadow-sm); }

        /* Badge */
        .rm-count { border-radius:var(--rm-radius-sm); padding:0 6px; min-width:22px; font-size:12px; font-weight:500; line-height:20px;
            background:var(--rm-primary); color:var(--rm-primary-fg); }
        .rm-seg a:not(.is-active) .rm-count { background:var(--rm-muted-strong); color:var(--rm-fg); }
        .rm-badge { border-radius:var(--rm-radius-sm); padding:2px 8px; font-size:12px; font-weight:500; }
        .rm-rec-pill { border-radius:var(--rm-radius-md); padding:2px 8px; font-size:12px; font-weight:500; }
        .rm-rec-link { border-radius:var(--rm-radius-sm); color:var(--rm-fg) !important; box-shadow:var(--rm-shadow-xs); }
        .rm-rec-link:hover { background:var(--rm-accent); }

        /* Button: outline / default / destructive / success */
        body.rm-redesign .rm-queue-card .header h2 > a,
        body.rm-redesign .rm-strip-actions .btn, body.rm-redesign .rm-strip-actions input[type="submit"],
        .rm-task-tab, .rm-task-open, .rm-clishe-toggle, .rm-clishe-retry, .rm-modal__foot button,
        body.rm-redesign .release-tracks-toggle {
            height:32px; box-sizing:border-box; border-radius:var(--rm-radius-md) !important; box-shadow:var(--rm-shadow-xs) !important;
            font-size:13px !important; font-weight:500 !important; transition:background .15s, color .15s, border-color .15s; }
        body.rm-redesign .rm-queue-card .header h2 > a { display:inline-flex; align-items:center; padding:0 12px; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .btn,
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .release-queue-btn,
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .rm-reject-btn {
            height:36px; padding:0 16px !important; display:flex !important; align-items:center; justify-content:center;
            box-sizing:border-box; text-decoration:none !important;
            border-radius:var(--rm-radius-md) !important; box-shadow:var(--rm-shadow-xs) !important;
            font-size:14px !important; font-weight:500 !important; transition:background .15s, color .15s, border-color .15s; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .btn-danger {
            color:var(--rm-destructive) !important; border-color:var(--rm-border) !important; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .btn-danger:hover {
            background:var(--rm-destructive-bg) !important; border-color:var(--rm-destructive-border) !important; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .rm-reject-btn { border-color:var(--rm-border); color:#b45309; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .rm-reject-btn:hover { background:#fffbeb; border-color:#fcd34d; }
        body.rm-redesign :is(button, a, [role="button"], [tabindex]):focus-visible {
            outline:none; box-shadow:var(--rm-ring-shadow) !important; }

        /* Toggle (Входящие / Исходящие) */
        .rm-task-tab { padding:0 8px 0 12px; }
        .rm-task-tab.is-open { background:var(--rm-accent); border-color:var(--rm-border); color:var(--rm-fg); }
        .rm-task-tab.is-open .rm-count { background:var(--rm-primary); color:var(--rm-primary-fg); }
        .rm-task-tab.is-open svg { color:var(--rm-fg); }
        .rm-task { border-radius:var(--rm-radius-lg); background:var(--rm-card); box-shadow:var(--rm-shadow-xs); border-color:var(--rm-border); }
        .rm-task-open { height:32px; }
        .rm-tasks-nav button { border-radius:var(--rm-radius-md); box-shadow:var(--rm-shadow-xs); }

        /* Input / Textarea */
        .rm-modal textarea, .rm-clishe { border-color:var(--rm-input); box-shadow:var(--rm-shadow-xs); border-radius:var(--rm-radius-md); }
        .rm-modal textarea:focus { border-color:var(--rm-ring); box-shadow:var(--rm-ring-shadow); }
        .rm-modal__prefix { border-radius:var(--rm-radius-md) var(--rm-radius-md) 0 0; border-color:var(--rm-input); background:var(--rm-muted-soft); }
        .rm-modal__prefix + textarea { border-radius:0 0 var(--rm-radius-md) var(--rm-radius-md); }
        .rm-clishe-searchbar { background:var(--rm-card); }
        .rm-clishe-search { height:36px; }
        .rm-clishe:focus-within { border-color:var(--rm-ring); box-shadow:var(--rm-ring-shadow); }

        /* Dialog */
        .rm-modal-overlay { background:rgb(0 0 0 / .5); animation:rm-fade .15s ease; }
        .rm-modal { border:1px solid var(--rm-border); border-radius:var(--rm-radius-lg); box-shadow:var(--rm-shadow-lg);
            animation:rm-zoom .15s ease; }
        .rm-modal__head { padding:24px 24px 0; }
        .rm-modal__title { font-size:18px; font-weight:600; letter-spacing:-.01em; }
        .rm-modal__sub { font-size:14px; color:var(--rm-muted-fg); }
        .rm-modal__body { padding:16px 24px 0; }
        .rm-modal__foot { padding:16px 24px 24px; }
        .rm-modal__foot button { height:36px; padding:0 16px; }
        .rm-modal__foot button:hover { background:var(--rm-accent); }
        .rm-modal__foot .rm-modal__primary:hover { filter:brightness(.92); background:var(--rm-destructive); }
        .rm-modal__foot .rm-modal__primary.is-rights:hover { background:#d97706; }
        .rm-modal-seg { background:var(--rm-muted); border-radius:var(--rm-radius-lg); }
        .rm-modal-seg button { border-radius:var(--rm-radius-md); font-size:14px; }
        .rm-modal-seg button.is-active { box-shadow:var(--rm-shadow-sm); }
        .rm-clishe-insert { height:32px; border-radius:var(--rm-radius-md); background:var(--rm-primary); }
        @keyframes rm-fade { from { opacity:0; } }
        @keyframes rm-zoom { from { opacity:0; transform:scale(.97); } }

        /* Skeleton — как в shadcn: bg-accent + pulse */
        @keyframes rm-pulse { 50% { opacity:.5; } }
        .rm-skel { background:var(--rm-skel) !important; background-size:auto !important; border-radius:var(--rm-radius-sm);
            animation:rm-pulse 2s cubic-bezier(.4, 0, .6, 1) infinite; }
        body.rm-redesign .rm-seg a .rm-count.is-loading { background:var(--rm-skel) !important; background-size:auto !important;
            animation:rm-pulse 2s cubic-bezier(.4, 0, .6, 1) infinite; }
        .rm-skel-fields .rai-label { color:var(--rm-subtle); }


        /* Графы релиза — ровная сетка: люди в первой строке, короткие графы во второй */
        .release-album-info.rm-fields { display:grid; width:100%; box-sizing:border-box; overflow:hidden;
            border:1px solid var(--rm-border); border-radius:var(--rm-radius-lg); background:var(--rm-card); }
        .rm-fields--song { grid-template-columns:repeat(6, minmax(0,1fr)); }
        .rm-fields--album { grid-template-columns:repeat(4, minmax(0,1fr)); }
        .rm-fields .rai-field { min-width:0; padding:10px 14px; border:none !important;
            box-shadow:1px 0 0 0 var(--rm-border-soft), 0 1px 0 0 var(--rm-border-soft); }
        .rm-fields .rai-field--wide { grid-column:span 2; }
        .rm-fields .rai-value { overflow-wrap:anywhere; }
        @media (max-width:1180px) {
            .rm-fields--song { grid-template-columns:repeat(3, minmax(0,1fr)); }
            .rm-fields--song .rai-field--wide { grid-column:span 3; }
            .rm-fields--album { grid-template-columns:repeat(2, minmax(0,1fr)); }
        }

        /* Статистика артиста — бейджи «подпись  число» */
        .rm-stats { gap:6px; align-items:center; }
        .rm-chip { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 8px; border:1px solid var(--rm-border);
            border-radius:var(--rm-radius-sm); background:var(--rm-card); font-size:12.5px; color:var(--rm-muted-fg); white-space:nowrap; }
        .rm-chip b { font-weight:600; color:var(--rm-fg); font-variant-numeric:tabular-nums; }
        .rm-chip--ok b { color:var(--rm-success); }
        .rm-chip--danger b { color:var(--rm-destructive); }
        .rm-chip--warn b { color:#b45309; }
        .rm-chip.is-alert { border-color:var(--rm-destructive-border); background:var(--rm-destructive-bg); color:var(--rm-destructive); }
        body.rm-redesign .rm-rating { height:24px; margin-left:4px; }

        /* Распознание — компактно, без акцента */
        body.rm-songs .table-responsive1 tr.rm-recog { padding:10px 20px !important; }
        body.rm-songs .table-responsive1 tr.rm-recog > td:nth-child(1) { padding-top:3px !important; }
        .rm-rec-head { gap:8px; min-height:24px; }
        .rm-rec-pill { height:22px; padding:0 8px; font-size:12px; font-weight:500; background:var(--rm-muted); color:var(--rm-fg-soft); }
        .rm-rec-pill--warn { background:#fffbeb; color:#b45309; }
        .rm-rec-pill--ok { background:var(--rm-muted); color:var(--rm-muted-fg); }
        .rm-rec-pill--bad { background:var(--rm-destructive-bg); color:var(--rm-destructive); }
        .rm-rec-count { font-size:12px; }
        .rm-rec-toggle { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px; border:none; border-radius:var(--rm-radius-sm);
            background:transparent; font:inherit; font-size:12.5px; font-weight:500; color:var(--rm-muted-fg); cursor:pointer; }
        .rm-rec-toggle:hover { background:var(--rm-accent); color:var(--rm-fg); }
        .rm-rec-toggle svg { transition:transform .15s; }
        .rm-rec-toggle.is-open svg { transform:rotate(180deg); }
        .rm-rec-list[hidden] { display:none; }
        .rm-rec-list { margin-top:10px; }
        .rm-rec-item { padding:8px 12px; }
        .rm-rec-title { font-size:13px; }
        .rm-rec-sub { font-size:12px; }


        /* =========================================================
           Карточка релиза без пустот: шапка (обложка + название + кнопки в ряд),
           ниже графы и плеер на всю ширину. Ячейка названия (td4) раскрыта через
           display:contents, чтобы её части встали в общую сетку.
        ========================================================= */
        html body.rm-songs .table-responsive1 tr[id],
        html body.rm-albums .table-responsive1 tr[id] {
            grid-template-columns:104px minmax(0,1fr) auto;
            grid-template-areas:"cover title actions" "cover meta actions" "extra extra extra" "fields fields fields" "ai ai ai";
            column-gap:20px; row-gap:0; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(4) { display:contents !important; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(2) { grid-area:cover; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(2) img { width:104px !important; height:104px !important; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(4) > p { grid-area:title; align-self:end; margin:0 !important; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(4) > .rm-meta-wrap { grid-area:meta; align-self:start; }
        html body.rm-songs .table-responsive1 tr[id] > td:nth-child(4) > .rm-extra,
        html body.rm-albums .table-responsive1 tr[id] > td:nth-child(4) > small { grid-area:extra; margin-top:14px !important; }
        html body.rm-songs .table-responsive1 tr[id] > td:nth-child(4) > .rm-details-slot,
        html body.rm-albums .table-responsive1 tr[id] > td:nth-child(4) > .release-album-info { grid-area:fields; margin-top:16px; }
        html body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) { grid-area:ai; margin-top:12px; }
        html body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) .rm-audio { flex:1 1 auto; max-width:none; }
        html body.rm-songs .table-responsive1 tr[id] > td:nth-child(9) .rm-audio .rm-player { max-width:none; }

        /* кнопки — в один ряд справа от названия */
        html body.rm-songs .table-responsive1 tr[id] > td:nth-child(10),
        html body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) {
            grid-area:actions; align-self:center; flex-direction:row !important; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .btn,
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .release-queue-btn,
        html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(n) .rm-reject-btn { width:auto !important; }

        /* Распознание: подпись по ширине обложки, текст — по линии названия */
        html body.rm-songs .table-responsive1 tr.rm-recog { grid-template-columns:104px minmax(0,1fr); column-gap:20px; }

        @media (max-width:1100px) {
            html body.rm-songs .table-responsive1 tr[id],
            html body.rm-albums .table-responsive1 tr[id] {
                grid-template-columns:72px minmax(0,1fr);
                grid-template-areas:"cover title" "cover meta" "actions actions" "extra extra" "fields fields" "ai ai"; }
            html body.rm-redesign .table-responsive1 tr[id] > td:nth-child(2) img { width:72px !important; height:72px !important; }
            html body.rm-songs .table-responsive1 tr[id] > td:nth-child(10),
            html body.rm-albums .table-responsive1 tr[id] > td:nth-child(9) { justify-content:flex-start; margin-top:14px; }
            html body.rm-songs .table-responsive1 tr.rm-recog { grid-template-columns:1fr; }
        }

        /* Плеер */
        .rm-player { border-radius:var(--rm-radius-lg) !important; box-shadow:var(--rm-shadow-xs); border-color:var(--rm-border) !important; }
        .rm-pl-play { border-radius:var(--rm-radius-md) !important; background:var(--rm-primary) !important; }
        .rm-pl-btn { border-radius:var(--rm-radius-sm) !important; }
        .rm-pl-menu { border-radius:var(--rm-radius-md) !important; box-shadow:var(--rm-shadow-lg) !important; }
        .rm-pl-menu button { border-radius:var(--rm-radius-sm) !important; }
    `;
    /*RM_CSS_END*/

    const RM_ICONS = {
        album: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/></svg>',
        track: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
        queue: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
        star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>',
        all: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
        user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="8" r="4"/><path d="M3 20c0-3.3 3.1-6 7-6"/><path d="M15 17l2 2 4-4"/></svg>',
    };

    function isSongsListPage() {
        return location.pathname.includes('/admin-cp/manage-songs');
    }

    function getQueueState() {
        const params = new URLSearchParams(location.search);
        const isPro = params.has('check_pro');
        return { isPro, isQueue: params.has('check') && !isPro };
    }

    /* ---------- тема: токены shadcn/ui (neutral) — нужны на всех страницах, где скрипт что-то рисует ---------- */

    const RM_THEME_CSS = `
        :root {
            --rm-font: "Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            --rm-page: #fafafa;
            --rm-card: #ffffff;
            --rm-fg: #0a0a0a;
            --rm-fg-soft: #404040;
            --rm-muted-fg: #737373;
            --rm-subtle: #a3a3a3;
            --rm-primary: #171717;
            --rm-primary-fg: #fafafa;
            --rm-muted: #f5f5f5;
            --rm-muted-soft: #fafafa;
            --rm-accent: #f5f5f5;
            --rm-muted-strong: #e5e5e5;
            --rm-skel: #efefef;
            --rm-border: #e5e5e5;
            --rm-border-soft: #f0f0f0;
            --rm-input: #e5e5e5;
            --rm-ring: #a1a1a1;
            --rm-ring-shadow: 0 0 0 3px rgb(161 161 161 / .5);
            --rm-destructive: #e7000b;
            --rm-destructive-bg: #fef2f2;
            --rm-destructive-border: #fecaca;
            --rm-success: #16a34a;
            --rm-success-hover: #15803d;
            --rm-success-bg: #dcfce7;
            --rm-link: #2563eb;
            --rm-radius-sm: 6px;
            --rm-radius-md: 8px;
            --rm-radius-lg: 10px;
            --rm-radius-xl: 14px;
            --rm-shadow-xs: 0 1px 2px 0 rgb(0 0 0 / .05);
            --rm-shadow-sm: 0 1px 3px 0 rgb(0 0 0 / .1), 0 1px 2px -1px rgb(0 0 0 / .1);
            --rm-shadow-lg: 0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1);
        }
    `;

    function ensureThemeTokens() {
        if (document.getElementById('rm-theme')) return;
        const style = document.createElement('style');
        style.id = 'rm-theme';
        style.textContent = RM_THEME_CSS;
        document.head.appendChild(style);
        // Geist — шрифт shadcn/ui; если не загрузится, останется системный
        const font = document.createElement('link');
        font.rel = 'stylesheet';
        font.href = 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap';
        document.head.appendChild(font);
    }

    function injectRedesignStyles() {
        ensureThemeTokens();
        if (document.getElementById('rm-styles')) return;
        const style = document.createElement('style');
        style.id = 'rm-styles';
        style.textContent = RM_CSS;
        document.head.appendChild(style);
    }

    function buildRedesignHeader(active) {
        const email = document.querySelector('#leftsidebar .info-container .email')?.textContent?.trim() || '';
        const login = email.split('@')[0] || '';
        const userName = MODERATOR_NAMES[login] || '';
        const tab = (key, href, icon, label) =>
            `<a href="${href}" class="${active === key ? 'is-active' : ''}">${icon}${label}</a>`;

        const header = document.createElement('header');
        header.id = 'rm-header';
        header.innerHTML = `
            <div class="rm-header__inner">
                <nav class="rm-tabs">
                    ${tab('albums', 'https://rumedia.io/media/admin-cp/manage-albums?check=1', RM_ICONS.album, 'Альбомы')}
                    ${tab('songs', 'https://rumedia.io/media/admin-cp/manage-songs?check=1', RM_ICONS.track, 'Синглы')}
                    ${tab('all', 'https://rumedia.io/media/admin-cp/manage-albums', RM_ICONS.all, 'Все релизы')}
                    ${tab('artists', 'https://rumedia.io/media/admin-cp/manage-artists', RM_ICONS.user, 'Заявки')}
                </nav>
                ${userName ? `<div class="rm-user"><b>${escapeHtml(userName)}</b> · ${escapeHtml(login)}</div>` : ''}
            </div>`;
        return header;
    }

    const QUEUE_TOTAL_RE = /Showing\s+\d+\s+out of\s+(\d+)/i;

    function buildQueueSwitch(base) {
        const { isPro, isQueue } = getQueueState();

        // Количество в текущей очереди — из скрытого «Showing 1 out of N» (на странице по одному релизу).
        const own = (document.querySelector('.table-responsive1 > .pull-left')?.textContent || '').match(QUEUE_TOTAL_RE);

        const seg = document.createElement('div');
        seg.className = 'rm-seg';
        [
            { href: `${base}?check=1`, label: 'Очередь', active: isQueue },
            { href: `${base}?check_pro=1`, label: 'Очередь премиумов', active: isPro },
        ].forEach((q) => {
            const link = document.createElement('a');
            link.href = q.href;
            if (q.active) link.className = 'is-active';
            link.textContent = q.label;

            const badge = document.createElement('span');
            badge.className = 'rm-count';
            link.appendChild(badge);
            seg.appendChild(link);

            if (q.active && own) badge.textContent = own[1];
            else loadQueueCount(q.href, badge);
        });
        return seg;
    }

    // Число релизов в другой очереди: один фоновый запрос её страницы, страницу не блокирует.
    async function loadQueueCount(url, badge) {
        badge.classList.add('is-loading');
        badge.textContent = '';
        try {
            const m = (await fetchHtml(url)).match(QUEUE_TOTAL_RE);
            if (!m) throw new Error('нет счётчика');
            badge.textContent = m[1];
            badge.classList.remove('is-loading');
        } catch (_) {
            badge.remove();
        }
    }

    // Прячем только колонки с поиском/фильтрами. Весь .row прятать нельзя: в разметке сайта
    // он бывает не закрыт, и таблица с релизами оказывается внутри него.
    function hideFilterCols(card) {
        card?.querySelectorAll('.body [class*="col-md-"]').forEach((col) => {
            if (col.querySelector('.table-responsive1') || col.closest('.table-responsive1')) return;
            if (col.querySelector('form, .site-settings-alert')) col.classList.add('rm-filters');
        });
    }

    // Текст заголовка полосы — в один span, иначе flex разносит слова и <strong> по разным ячейкам.
    function wrapStripText(h2) {
        if (!h2 || h2.querySelector(':scope > .rm-strip-text')) return;
        const span = document.createElement('span');
        span.className = 'rm-strip-text';
        while (h2.firstChild && !(h2.firstChild.nodeType === 1 && h2.firstChild.tagName === 'A')) {
            span.appendChild(h2.firstChild);
        }
        h2.prepend(span);
    }

    /* ---------- задачи (входящие / исходящие) ---------- */

    const TASKS_PER_PAGE = 4;
    const CHEVRON_DOWN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

    // Текст <p> с <br> -> строки (элемент скрыт, поэтому innerText не подходит).
    function textLines(el) {
        if (!el) return [];
        const clone = el.cloneNode(true);
        clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
        return clone.textContent.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    }

    function parseTaskCard(col) {
        const box = col.querySelector('.card > div') || col;
        const ps = Array.from(box.querySelectorAll(':scope > p'));
        const prio = ps[0]?.querySelector('span');
        const log = textLines(ps[2]);
        const dateLine = /^\d{1,2}\/\d{1,2}/.test(log[0] || '') ? log.shift() : '';
        const who = log.length && !/^Комментарий:/i.test(log[0]) ? log.shift() : '';
        const rest = log.filter((l) => !/^Комментарий:\s*$/i.test(l));
        return {
            title: (box.querySelector('h4')?.textContent || '').trim() || 'Без названия',
            prio: (prio?.textContent || '').trim(),
            prioColor: prio?.style.color || '',
            desc: (ps[1]?.textContent || '').replace(/\u00a0/g, ' ').trim(),
            date: dateLine,
            who,
            text: rest.join('\n'),
            button: box.querySelector('button'),
        };
    }

    // Список задач: карточки по TASKS_PER_PAGE со стрелками. Кнопка «Открыть» жмёт оригинальную кнопку сайта.
    function buildTasksList(panel) {
        const row = panel.querySelector(':scope > .row');
        const tasks = Array.from(panel.querySelectorAll('.col-md-3')).map(parseTaskCard);
        if (row) row.style.display = 'none';

        const wrap = document.createElement('div');
        wrap.className = 'rm-tasks';
        if (!tasks.length) {
            wrap.innerHTML = '<div class="rm-tasks-empty">Задач нет</div>';
            panel.appendChild(wrap);
            return 0;
        }

        wrap.innerHTML = `
            <div class="rm-tasks-bar">
                <span class="rm-tasks-range"></span>
                <span class="rm-tasks-nav">
                    <button type="button" data-dir="-1" title="Назад"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m15 18-6-6 6-6"/></svg></button>
                    <button type="button" data-dir="1" title="Вперёд"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="m9 18 6-6-6-6"/></svg></button>
                </span>
            </div>
            <div class="rm-tasks-grid"></div>`;
        const grid = wrap.querySelector('.rm-tasks-grid');
        const range = wrap.querySelector('.rm-tasks-range');
        const nav = wrap.querySelector('.rm-tasks-nav');
        const [prev, next] = nav.querySelectorAll('button');

        const cards = tasks.map((t) => {
            const card = document.createElement('div');
            card.className = 'rm-task';
            card.innerHTML = `
                <div class="rm-task-top">
                    ${t.prio ? `<span class="rm-task-prio">${escapeHtml(t.prio)}</span>` : ''}
                    ${t.date ? `<span class="rm-task-date">${escapeHtml(t.date)}</span>` : ''}
                </div>
                <div class="rm-task-title">${escapeHtml(t.title)}</div>
                ${t.who ? `<div class="rm-task-who">${escapeHtml(t.who)}</div>` : ''}
                ${t.desc ? `<div class="rm-task-text">${escapeHtml(t.desc)}</div>` : ''}
                ${t.text ? `<div class="rm-task-text">${escapeHtml(t.text)}</div>` : ''}
                ${t.button ? '<button type="button" class="rm-task-open">Открыть</button>' : ''}`;
            if (t.prioColor) card.querySelector('.rm-task-prio')?.style.setProperty('--prio', t.prioColor);
            card.querySelector('.rm-task-open')?.addEventListener('click', () => t.button.click());
            grid.appendChild(card);
            return card;
        });

        const pages = Math.ceil(cards.length / TASKS_PER_PAGE);
        let page = 0;
        const show = () => {
            const from = page * TASKS_PER_PAGE;
            const to = Math.min(from + TASKS_PER_PAGE, cards.length);
            cards.forEach((c, i) => { c.hidden = i < from || i >= to; });
            range.innerHTML = pages > 1 ? `<b>${from + 1}–${to}</b> из ${cards.length}` : `Всего: <b>${cards.length}</b>`;
            prev.disabled = page === 0;
            next.disabled = page >= pages - 1;
        };
        nav.hidden = pages < 2;
        nav.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-dir]');
            if (!btn || btn.disabled) return;
            page = Math.max(0, Math.min(pages - 1, page + Number(btn.dataset.dir)));
            show();
        });
        show();
        panel.appendChild(wrap);
        return cards.length;
    }

    // Полоса задач: вместо текста и сломанной ссылки сайта «Показать исходящие» — две кнопки,
    // каждая открывает и сворачивает свой список. По умолчанию оба свёрнуты.
    function buildTasksSwitch(h2, panels) {
        const text = h2.textContent.replace(/\s+/g, ' ');
        const headerCount = (re) => (text.match(re) || [])[1];
        const defs = [
            { key: 'in', label: 'Входящие', panel: panels.in, count: headerCount(/(\d+)\s*входящ/i) },
            { key: 'out', label: 'Исходящие', panel: panels.out, count: headerCount(/(\d+)\s*исходящ/i) },
        ].filter((d) => d.panel);

        h2.querySelectorAll(':scope > a').forEach((a) => {
            if (/tasks_(show|out)/.test(a.getAttribute('onclick') || '') || /входящие|исходящие/i.test(a.textContent)) a.remove();
        });
        const label = h2.querySelector(':scope > .rm-strip-text');
        if (label) label.textContent = 'Задачи';

        const tabs = defs.map((d) => {
            const n = buildTasksList(d.panel);
            d.panel.style.display = 'none';
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'rm-task-tab';
            tab.setAttribute('aria-expanded', 'false');
            tab.innerHTML = `${d.label}<span class="rm-count">${escapeHtml(d.count ?? String(n))}</span>${CHEVRON_DOWN}`;
            tab.title = `Открыть ${d.label.toLowerCase()}`;
            return { ...d, tab };
        });

        const setOpen = (item, open) => {
            item.panel.style.display = open ? '' : 'none';
            item.tab.classList.toggle('is-open', open);
            item.tab.setAttribute('aria-expanded', String(open));
            item.tab.title = `${open ? 'Свернуть' : 'Открыть'} ${item.label.toLowerCase()}`;
        };
        tabs.forEach((item) => {
            item.tab.addEventListener('click', () => {
                const open = item.panel.style.display === 'none';
                tabs.forEach((other) => setOpen(other, other === item && open));
            });
        });

        const anchor = h2.querySelector(':scope > .rm-strip-actions');
        tabs.forEach((item) => h2.insertBefore(item.tab, anchor));
    }

    /* ---------- панель «Очередь на отгрузку» ---------- */

    // Шапка: «Отгрузка» + бейджи + своя кнопка Показать/Скрыть (у сайта «Открыть» только открывает).
    // Внутри: строка действий и аккуратный список релизов со статусом. Действия сайта (Готово, Все готовы,
    // запуск отгрузки) не переписываем — используем его же ссылки и форму.
    function enhanceShipQueue(h2, panel) {
        if (!h2 || !panel || panel.dataset.rmShip) return;
        panel.dataset.rmShip = '1';

        const label = h2.querySelector(':scope > .rm-strip-text');
        const text = (label?.textContent || '').replace(/\s+/g, ' ');
        const total = Number((text.match(/отгрузку\s+(\d+)/i) || [])[1] || 0);
        const review = Number((text.match(/(\d+)\s+нужда/i) || [])[1] || 0);

        h2.querySelectorAll(':scope > a').forEach((a) => {
            if (/#queue/.test(a.getAttribute('onclick') || '')) a.remove();
        });
        if (label) {
            label.innerHTML = `Отгрузка
                <span class="rm-ship-badge">${total} ${pluralize(total, ['релиз', 'релиза', 'релизов'])}</span>
                ${review ? `<span class="rm-ship-badge is-warn">${review} на проверке</span>` : ''}`;
        }

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'rm-task-tab rm-ship-toggle';
        toggle.setAttribute('aria-expanded', 'false');
        const setOpen = (open) => {
            panel.style.display = open ? '' : 'none';
            toggle.classList.toggle('is-open', open);
            toggle.setAttribute('aria-expanded', String(open));
            toggle.innerHTML = `${open ? 'Скрыть' : 'Показать'}${CHEVRON_DOWN}`;
        };
        toggle.addEventListener('click', () => setOpen(panel.style.display === 'none'));
        label ? label.after(toggle) : h2.prepend(toggle);
        setOpen(false);

        // --- строка действий ---
        const launch = panel.querySelector('a[href*="queue.php"]');
        const copyLink = Array.from(panel.querySelectorAll('a[onclick]')).find((a) => /amp_open/.test(a.getAttribute('onclick')));
        const allForm = panel.querySelector('input[name="all_ready"]')?.closest('form');
        const table = panel.querySelector('table');
        const rows = table ? Array.from(table.querySelectorAll('tr')) : [];

        const bar = document.createElement('div');
        bar.className = 'rm-ship-bar';

        if (launch) {
            const a = document.createElement('a');
            a.className = 'rm-ship-btn is-primary';
            a.href = launch.href;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = `Запустить отгрузку · ${total}`;
            bar.appendChild(a);
            launch.remove();
        }

        const ampCount = panel.querySelectorAll('.amp_open').length;
        if (copyLink) {
            copyLink.remove();
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rm-ship-btn';
            btn.textContent = `Скопировать ссылки Ampsuite · ${ampCount}`;
            btn.addEventListener('click', async () => {
                const links = Array.from(panel.querySelectorAll('.amp_open')).map((a) => a.href).join('\n');
                try {
                    await navigator.clipboard.writeText(links);
                } catch (_) {
                    const ta = document.createElement('textarea');
                    ta.value = links;
                    ta.style.cssText = 'position:fixed; opacity:0;';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                }
                const old = btn.textContent;
                btn.textContent = 'Скопировано ✓';
                setTimeout(() => (btn.textContent = old), 1500);
            });
            bar.appendChild(btn);
        }

        const okRows = rows.filter((tr) => /✓/.test(tr.querySelector('td:nth-child(2)')?.textContent || ''));
        if (allForm) {
            const submit = allForm.querySelector('input[name="all_ready"]');
            submit.value = 'Применить готово для всех';
            submit.title = 'Отмечает «Готово» все релизы с ✓ — они уйдут из этой очереди. Релизы с ошибкой останутся.';
            submit.className = 'rm-ship-btn is-success';
            allForm.classList.add('rm-ship-allform');
            allForm.addEventListener('submit', (e) => {
                const n = okRows.length;
                if (!confirm(`Применить «Готово» для ${n} ${pluralize(n, ['релиза', 'релизов', 'релизов'])}? Они уйдут из очереди на отгрузку.`)) {
                    e.preventDefault();
                }
            });
            bar.appendChild(allForm);
        }

        // --- список релизов ---
        if (table) {
            table.className = 'rm-ship-table';
            rows.forEach((tr) => {
                const tds = tr.querySelectorAll('td');
                const releaseLink = tds[0]?.querySelector('a');
                const ampLink = tds[1]?.querySelector('a');
                const doneLink = tds[2]?.querySelector('a');
                const href = releaseLink?.getAttribute('href') || '';
                const kind = /edit-album/.test(href) ? 'Альбом' : 'Сингл';
                const statusText = ((tds[1]?.textContent || '').replace(ampLink?.textContent || '', '')).replace(/\s+/g, ' ').trim();
                // ✓ у сайта — релиз ушёл в Ampsuite и ждёт проверки модератором (потом «Готово»).
                const needsCheck = /^✓/.test(statusText);

                const cell = (cls, ...nodes) => {
                    const td = document.createElement('td');
                    td.className = cls;
                    nodes.filter(Boolean).forEach((n) => td.append(n));
                    return td;
                };
                const status = document.createElement('span');
                status.className = `rm-ship-status ${needsCheck ? 'is-warn' : 'is-muted'}`;
                status.textContent = needsCheck ? 'Требует проверки' : statusText.replace(/^[✗✕×]\s*/, '') || 'В очереди';
                const main = document.createElement('span');
                main.className = 'rm-ship-kind';
                main.textContent = kind;
                if (releaseLink) { releaseLink.className = 'rm-ship-link'; releaseLink.textContent = 'Релиз ↗'; }
                if (ampLink) { ampLink.classList.add('rm-ship-link'); ampLink.textContent = 'Ampsuite ↗'; }
                if (doneLink) { doneLink.className = 'rm-ship-btn rm-ship-done'; doneLink.textContent = 'Готово'; doneLink.setAttribute('role', 'button'); }

                tr.replaceChildren(
                    cell('rm-ship-c-status', status),
                    cell('rm-ship-c-main', main),
                    cell('rm-ship-c-links', releaseLink, ampLink),
                    cell('rm-ship-c-done', doneLink)
                );
            });
            if (!rows.length) {
                const empty = document.createElement('div');
                empty.className = 'rm-ship-empty';
                empty.textContent = 'Очередь на отгрузку пуста';
                table.replaceWith(empty);
            }
        }

        // остатки разметки сайта: <br>, пустой текст, скрытое поле копирования
        Array.from(panel.childNodes).forEach((n) => {
            if (n.nodeType === 3 || n.nodeType === 8 || (n.nodeType === 1 && (n.tagName === 'BR' || n.id === 'text_copy'))) {
                if (n.id === 'text_copy') n.style.display = 'none';
                else n.remove();
            }
        });
        panel.prepend(bar);
    }

    function applyAlbumsRedesign() {
        if (!isAlbumsListPage() || document.body.classList.contains('rm-redesign')) return;

        injectRedesignStyles();
        document.body.classList.add('rm-redesign', 'rm-albums');
        // Очереди альбомов — вкладка «Альбомы», общий список без очереди — «Все релизы».
        const { isPro, isQueue } = getQueueState();
        document.body.insertBefore(buildRedesignHeader(isPro || isQueue ? 'albums' : 'all'), document.body.firstChild);

        const queueCard = document.getElementById('queue')?.closest('.card');
        queueCard?.classList.add('rm-queue-card');
        const queueH2 = queueCard?.querySelector('.header h2');
        wrapStripText(queueH2);
        queueH2?.appendChild(buildQueueSwitch('https://rumedia.io/media/admin-cp/manage-albums'));
        enhanceShipQueue(queueH2, document.getElementById('queue'));

        const listCard = document.querySelector('.table-responsive1')?.closest('.card');
        listCard?.classList.add('rm-list-card');
        hideFilterCols(listCard);

        polishAlbumRows();
    }

    function applySongsRedesign() {
        if (!isSongsListPage() || document.body.classList.contains('rm-redesign')) return;
        const card = document.querySelector('.table-responsive1')?.closest('.card');
        if (!card) return;

        injectRedesignStyles();
        document.body.classList.add('rm-redesign', 'rm-songs');
        document.body.insertBefore(buildRedesignHeader('songs'), document.body.firstChild);
        card.classList.add('rm-list-card');

        const headers = Array.from(card.querySelectorAll(':scope > .header'));
        const queueHeader = headers.find((h) => /отгрузку/i.test(h.textContent));
        const tasksHeader = headers.find((h) => /задач/i.test(h.textContent));

        const makeStrip = (...nodes) => {
            const strip = document.createElement('div');
            strip.className = 'rm-queue-card';
            nodes.filter(Boolean).forEach((n) => strip.appendChild(n));
            return strip;
        };

        let queueStrip = null;
        if (queueHeader) {
            const h2 = queueHeader.querySelector('h2');
            wrapStripText(h2);
            h2?.appendChild(buildQueueSwitch('https://rumedia.io/media/admin-cp/manage-songs'));
            enhanceShipQueue(h2, document.getElementById('queue'));
            queueStrip = makeStrip(queueHeader, document.getElementById('queue'));
        }

        let tasksStrip = null;
        if (tasksHeader) {
            const h2 = tasksHeader.querySelector('h2');
            wrapStripText(h2);
            const actions = document.createElement('div');
            actions.className = 'rm-strip-actions';
            const checkAudio = card.querySelector(':scope > form input[name="check_audio"]')?.closest('form');
            if (checkAudio) checkAudio.style.display = 'none';
            const createTask = document.querySelector('#crm button');
            if (createTask) actions.appendChild(createTask);
            h2?.appendChild(actions);
            if (h2) {
                buildTasksSwitch(h2, {
                    in: document.getElementById('tasks_show'),
                    out: document.getElementById('tasks_out'),
                });
            }
            tasksStrip = makeStrip(tasksHeader, document.getElementById('tasks_show'), document.getElementById('tasks_out'));
        }

        // Убираем россыпь <br>/пробелов и старые кнопки «Очередь / Очередь премиумов».
        Array.from(card.childNodes).forEach((n) => {
            if (n.nodeType === 3) n.remove();
            else if (n.nodeType === 1 && (n.tagName === 'BR' || n.matches('a[href="?check=1"], a[href="?check_pro=1"]'))) {
                n.remove();
            }
        });

        if (tasksStrip) card.prepend(tasksStrip);
        if (queueStrip) card.prepend(queueStrip);
        hideFilterCols(card);

        polishSongRows();
    }

    function parseArtistCell(cell) {
        const link = cell?.querySelector('a[href*="/media/"]');
        const info = {
            href: link?.getAttribute('href') || '#',
            avatar: link?.querySelector('img')?.getAttribute('src') || '',
            name: (link?.textContent || '').trim(),
            isPremium: false,
            stats: [],
        };
        if (!cell) return info;

        info.isPremium = /Премиум/i.test(
            Array.from(cell.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent)
                .join(' ')
        );

        Array.from(cell.children).forEach((el) => {
            if (el.tagName !== 'SPAN') return;
            const style = el.getAttribute('style') || '';
            if (/white-space\s*:\s*nowrap/i.test(style)) return; // рейтинг +/- (переносится отдельно)
            const text = el.textContent.replace(/\s+/g, ' ').trim();
            if (!text) return;
            const colorSrc = (el.querySelector('span[style*="color"]') || el).getAttribute('style') || '';
            const kind = /red/i.test(colorSrc)
                ? 'red'
                : /orange/i.test(colorSrc)
                  ? 'orange'
                  : /green/i.test(colorSrc)
                    ? 'green'
                    : '';
            info.stats.push({ text, kind });
        });
        return info;
    }

    // Строка «исполнитель · жанр · загружено» + статистика и рейтинг.
    // Рейтинг ПЕРЕНОСИТСЯ (не копируется): его +/- обновляют число по id="rate-…",
    // и дубль с тем же id сломал бы обновление.
    // «Отправлено: 14» / «Нет отправленных!» / «Отклонено: 2» → бейдж «Подпись  число».
    function buildStatChip(stat) {
        const text = stat.text.replace(/!+$/, '').trim();
        let label = text;
        let num = '';
        const m = text.match(/^(.*?):\s*(\d+)$/);
        if (m) {
            label = m[1];
            num = m[2];
        } else if (/^нет\s+отправлен/i.test(text)) {
            label = 'Отправлено';
            num = '0';
        }
        const tone = /отправлен/i.test(label)
            ? (num === '0' ? 'danger' : 'ok')
            : /отклон/i.test(label)
              ? 'danger'
              : /подтвержд/i.test(label)
                ? 'warn'
                : stat.kind === 'red' ? 'danger' : stat.kind === 'orange' ? 'warn' : stat.kind === 'green' ? 'ok' : '';
        const zero = /отправлен/i.test(label) && num === '0';
        return `<span class="rm-chip${tone ? ' rm-chip--' + tone : ''}${zero ? ' is-alert' : ''}" title="${escapeHtml(stat.text)}">
            <span class="rm-chip-label">${escapeHtml(label)}</span>${num !== '' ? `<b>${escapeHtml(num)}</b>` : ''}</span>`;
    }

    function buildMetaWrap(row, genreTd, uploadedTd) {
        const artistCell = row.querySelector('td:nth-child(3)');
        const a = parseArtistCell(artistCell);
        const genre = (row.querySelector(`td:nth-child(${genreTd})`)?.textContent || '').trim();
        const uploaded = (row.querySelector(`td:nth-child(${uploadedTd})`)?.textContent || '').trim();

        const parts = [
            `<a class="rm-artist" href="${escapeHtml(a.href)}" target="_blank">
                ${a.avatar ? `<img src="${escapeHtml(a.avatar)}" alt="" data-zoom-bound="1">` : ''}
                <span>${escapeHtml(a.name || '—')}</span>
            </a>${a.isPremium ? '<span class="rm-badge">Премиум</span>' : ''}`,
        ];
        // Жанр показываем отдельной графой перед «Дата релиза» (buildSongFieldsHtml / buildAlbumInfoHtml).
        row.dataset.rmGenre = genre;
        if (uploaded) parts.push(`<span>${escapeHtml(uploaded)}</span>`);

        const wrap = document.createElement('div');
        wrap.className = 'rm-meta-wrap';
        wrap.innerHTML = `
            <div class="rm-meta">${parts.join('<span class="rm-sep">·</span>')}</div>
            <div class="rm-stats">${a.stats.map(buildStatChip).join('')}</div>`;

        const rating = artistCell?.querySelector(':scope > span[style*="white-space"]');
        if (rating) {
            rating.classList.add('rm-rating');
            wrap.querySelector('.rm-stats').appendChild(rating);
        }
        if (!wrap.querySelector('.rm-stats').children.length) wrap.querySelector('.rm-stats').remove();
        return wrap;
    }

    function polishAlbumRows() {
        if (!document.body.classList.contains('rm-albums')) return;

        document.querySelectorAll('.table-responsive1 tbody tr[id]').forEach((row) => {
            if (row.dataset.rmPolished) return;
            row.dataset.rmPolished = '1';

            const main = row.querySelector('td:nth-child(4)');
            if (!main) return;

            const actionsTd = row.querySelector('td:nth-child(9)');
            if (actionsTd && !actionsTd.querySelector('.rm-reject-btn')) {
                const rejectBtn = document.createElement('button');
                rejectBtn.type = 'button';
                rejectBtn.className = 'rm-reject-btn';
                rejectBtn.textContent = 'Отклонить';
                rejectBtn.addEventListener('click', () => openDecisionModal(getAlbumRowInfo(row)));
                actionsTd.appendChild(rejectBtn);
            }

            const meta = buildMetaWrap(row, 5, 8);
            const title = main.querySelector(':scope > p');
            if (title) title.insertAdjacentElement('afterend', meta);
            else main.prepend(meta);
        });
    }

    // «Распознание»: статус + совпадения (разделены двойным <br>) + группы ссылок (разделены тройным <br>).
    function polishRecognitionRow(tr) {
        const [labelTd, statusTd, , matchesTd, linksTd] = Array.from(tr.children);
        if (!statusTd || statusTd.dataset.rmRec) return;
        statusTd.dataset.rmRec = '1';

        const badge = statusTd.querySelector('.badge');
        const badgeInfo = `${badge?.className || ''} ${badge?.getAttribute('style') || ''}`;
        const statusText = (statusTd.textContent || '').replace(badge?.textContent || '', '').replace(/\s+/g, ' ').trim();
        const tone = /success|28a745|40c057/i.test(badgeInfo)
            ? 'ok'
            : /danger|dc3545|fa5252/i.test(badgeInfo)
              ? 'bad'
              : /warning|ffc107/i.test(badgeInfo)
                ? 'warn'
                : '';

        const textOf = (html) => {
            const d = document.createElement('div');
            d.innerHTML = html;
            return d.textContent.replace(/\s+/g, ' ').trim();
        };

        const entries = (matchesTd?.innerHTML || '')
            .split(/(?:<br\s*\/?>\s*){2,}/i)
            .map((chunk) => chunk.split(/<br\s*\/?>/i).map(textOf).filter(Boolean))
            .filter((lines) => lines.length);

        const linkGroups = (linksTd?.innerHTML || '')
            .split(/(?:<br\s*\/?>\s*){3,}/i)
            .map((chunk) => {
                const d = document.createElement('div');
                d.innerHTML = chunk;
                return Array.from(d.querySelectorAll('a'))
                    .map((a) => ({ href: a.getAttribute('href') || '', text: a.textContent.trim() }))
                    .filter((l) => /^https?:\/\//i.test(l.href) && l.text);
            })
            .filter((g) => g.length);

        const items = entries
            .map((lines, i) => {
                const head = lines[0];
                const m = head.match(/^(.*?),?\s+-\s+(.*?)(?:\s*\(Альбом:\s*(.*)\))?$/);
                const artist = m ? m[1].replace(/[\s,]+$/, '') : '';
                const title = m ? m[2] : head;
                const sub = [m && m[3] ? `Альбом: ${m[3]}` : '', ...lines.slice(1)].filter(Boolean);
                const links = (linkGroups[i] || [])
                    .map((l) => `<a class="rm-rec-link" href="${escapeHtml(l.href)}" target="_blank" rel="noopener">${escapeHtml(l.text)}</a>`)
                    .join('');
                return `<div class="rm-rec-item">
                    <div class="rm-rec-main">
                        <div class="rm-rec-title">${escapeHtml(title)}${artist ? `<span class="rm-rec-artist"> — ${escapeHtml(artist)}</span>` : ''}</div>
                        ${sub.length ? `<div class="rm-rec-sub">${sub.map(escapeHtml).join(' · ')}</div>` : ''}
                    </div>
                    ${links ? `<div class="rm-rec-links">${links}</div>` : ''}
                </div>`;
            })
            .join('');

        const count = entries.length
            ? `<span class="rm-rec-count">${entries.length} ${pluralize(entries.length, ['совпадение', 'совпадения', 'совпадений'])}</span>`
            : '';

        statusTd.innerHTML = `
            <div class="rm-rec-head">
                <span class="rm-rec-pill${tone ? ' rm-rec-pill--' + tone : ''}">${escapeHtml(statusText || 'Нет данных')}</span>
                ${count}
                ${items ? `<button type="button" class="rm-rec-toggle" aria-expanded="false">Показать${CHEVRON_DOWN}</button>` : ''}
            </div>
            ${items ? `<div class="rm-rec-list" hidden>${items}</div>` : ''}`;
        const recToggle = statusTd.querySelector('.rm-rec-toggle');
        const recList = statusTd.querySelector('.rm-rec-list');
        recToggle?.addEventListener('click', () => {
            const open = recList.hidden;
            recList.hidden = !open;
            recToggle.classList.toggle('is-open', open);
            recToggle.setAttribute('aria-expanded', String(open));
            recToggle.innerHTML = `${open ? 'Скрыть' : 'Показать'}${CHEVRON_DOWN}`;
        });
        if (labelTd) labelTd.textContent = 'Распознание';
    }

    /* ---------- решение по релизу: отклонить / подтверждение прав (синглы и альбомы) ---------- */

    const DECISION_STATUS = { reject: 3, rights: 7 };
    const rejectPrefix = (login) => `@${login} К сожалению, ваш релиз был отклонен. Причина:`;
    const rightsTemplate = (login, title, kind) =>
        `@${login}. Подскажите, пожалуйста, есть ли у вас права на использование инструментала в загруженном ${kind === 'album' ? 'альбоме' : 'треке'} "${title}"? ` +
        'Доказательством наличия прав может являться договор с битмейкером, либо небольшое видео с проектом в секвенсоре. ' +
        'Вы можете направить информацию в чат, после чего релиз отправится на площадки.';

    function getSongRowInfo(row) {
        const link = row.querySelector('a[href*="edit-track/"]')?.getAttribute('href') || '';
        return {
            kind: 'song',
            id: row.querySelector('input[name="audio_id"]')?.value || link.match(/edit-track\/([A-Za-z0-9]+)/)?.[1] || '',
            login: getAlbumArtistLogin(row),
            title: row.querySelector('.rm-title')?.textContent.trim() || '',
        };
    }

    function getAlbumRowInfo(row) {
        return {
            kind: 'album',
            id: getAlbumEditId(row) || '', // id для edit-album / update-album
            albumNum: /^\d+$/.test(row.id) ? row.id : '', // числовой id для комментария
            login: getAlbumArtistLogin(row),
            title: row.querySelector('td:nth-child(4) > p')?.textContent.trim() || '',
        };
    }

    async function postRumediaForm(url, params) {
        const res = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: params.toString(),
        });
        if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            // не JSON — ориентируемся на код ответа
        }
        if (data && data.status && Number(data.status) !== 200) {
            if (Number(data.status) === 300) throw new Error('сессия истекла, войдите заново');
            const errs = Array.isArray(data.errors) ? data.errors.join(', ') : '';
            throw new Error(data.message || errs || `статус ответа ${data.status}`);
        }
        return data;
    }

    function editTrackUrl(audioId) {
        return `https://rumedia.io/media/edit-track/${audioId}`;
    }

    function editAlbumUrl(albumId) {
        return `https://rumedia.io/media/edit-album/${albumId}`;
    }

    const RELEASE_KINDS = {
        song: { noun: 'трека', editUrl: (id) => editTrackUrl(id), endpoint: /edit-song/ },
        album: { noun: 'альбома', editUrl: (id) => editAlbumUrl(id), endpoint: /update-album/ },
    };

    // Ждём, пока в скрытом окне загрузится edit-track и отработают его ready-обработчики
    // (они, например, заполняют поле исполнителя из списка артистов).
    function waitForEditPage(iframe, timeoutMs) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const tick = () => {
                let win;
                try {
                    win = iframe.contentWindow;
                    const doc = win?.document;
                    if (doc && doc.readyState !== 'loading' && win.jQuery && doc.querySelector('[name="song-id"]')) {
                        win.jQuery(() => resolve(win));
                        return;
                    }
                } catch (_) {
                    reject(new Error('нет доступа к странице трека'));
                    return;
                }
                if (Date.now() - started > timeoutMs) reject(new Error('страница трека не загрузилась'));
                else setTimeout(tick, 150);
            };
            tick();
        });
    }

    // edit-song сохраняет ВСЮ форму трека. Чтобы ничего не потерять, сохраняет сам сайт:
    // открываем edit-track в скрытом окне, меняем только статус и отправляем форму его же обработчиком.
    async function saveReleaseStatus(info, status) {
        const kind = RELEASE_KINDS[info.kind];
        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.style.cssText = 'position:fixed; left:-10000px; top:0; width:1200px; height:800px; border:0; visibility:hidden;';
        iframe.src = kind.editUrl(info.id);
        document.body.appendChild(iframe);

        try {
            const win = await waitForEditPage(iframe, 30000);
            const $ = win.jQuery;
            const doc = win.document;
            const form = doc.querySelector('[name="song-id"]').closest('form');

            if (!form) throw new Error(`не нашёл форму ${kind.noun}`);
            if (form.querySelector('[name="song-id"]').value !== info.id) throw new Error(`id ${kind.noun} в форме не совпадает`);
            if (!(form.querySelector('[name="title"]')?.value || '').trim()) throw new Error('в форме пустое название');

            const statusEl = form.querySelector('[name="status"]');
            if (!statusEl) throw new Error(`в форме ${kind.noun} нет поля статуса`);
            statusEl.value = String(status);
            if (statusEl.value !== String(status)) throw new Error(`в форме нет статуса ${status}`);

            // Сохраняем только если форма отправляется через ajax-обработчик сайта (jquery.form).
            if (!$._data(form, 'events')?.submit) throw new Error(`форма ${kind.noun} сохраняется непривычно — ничего не отправляю`);

            return await new Promise((resolve, reject) => {
                const done = (fn, arg) => {
                    clearTimeout(timer);
                    $(doc).off('ajaxComplete.rmsave');
                    fn(arg);
                };
                const timer = setTimeout(() => done(reject, new Error('сайт не ответил на сохранение')), 30000);
                $(doc).on('ajaxComplete.rmsave', (e, xhr, settings) => {
                    if (!kind.endpoint.test(settings?.url || '')) return;
                    let data = xhr.responseJSON;
                    if (!data) {
                        try {
                            data = JSON.parse(xhr.responseText);
                        } catch (_) {
                            data = null;
                        }
                    }
                    if (xhr.status >= 200 && xhr.status < 300 && data && Number(data.status) === 200) done(resolve, data);
                    else done(reject, new Error(data?.message || `сервер ответил ${xhr.status}`));
                });
                $(form).trigger('submit');
            });
        } finally {
            iframe.remove();
        }
    }

    async function postReleaseComment(info, text) {
        const hashId = document.querySelector('.main_session')?.value || '';
        const params =
            info.kind === 'album'
                ? { hash_id: hashId, id: info.albumNum, value: text, timePercentage: '', time: '', wave: '0', album_id: info.albumNum }
                : { hash_id: hashId, id: info.id, value: text, timePercentage: '', time: '', wave: '0' };
        await postRumediaForm('https://rumedia.io/media/endpoints/register-comment', new URLSearchParams(params));
    }

    /* ---------- клише (данные расширения «MANAGER PASTE RUMEDIA») ---------- */

    const CLISHE_API = 'https://shalyn.work/pastes/get_pastes.php';
    const CLISHE_TTL_MS = 5 * 60 * 1000;
    const CLISHE_MANAGE_URL = 'https://shalyn.work/pastes/manage/';
    let clisheCache = null;

    // HTML пасты -> обычный текст. DOMParser не выполняет скрипты и не грузит картинки.
    function clisheToText(html) {
        const withBreaks = String(html || '').replace(/<br\s*\/?>/gi, '\n');
        return (new DOMParser().parseFromString(withBreaks, 'text/html').body.textContent || '').trim();
    }

    async function loadClishe(force = false) {
        if (!force && clisheCache && Date.now() - clisheCache.at < CLISHE_TTL_MS) return clisheCache.items;
        const res = await fetch(CLISHE_API, { cache: 'no-store' });
        if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('неожиданный ответ сервера');
        const items = data
            .map((p) => ({ id: String(p.id), name: String(p.name || '').trim() || 'Без названия', text: clisheToText(p.content) }))
            .filter((p) => p.text);
        clisheCache = { at: Date.now(), items };
        return items;
    }

    // Панель выбора клише внутри окна решения. onInsert(block) получает готовый текст.
    function bindClishePanel(root, onInsert) {
        const box = root.querySelector('.rm-clishe');
        const toggle = root.querySelector('.rm-clishe-toggle');
        const search = root.querySelector('.rm-clishe-search');
        const list = root.querySelector('.rm-clishe-list');
        const count = root.querySelector('.rm-clishe-count');
        const insert = root.querySelector('.rm-clishe-insert');
        const manage = root.querySelector('.rm-clishe-manage');
        let items = null;
        const picked = []; // id в порядке выбора

        const render = () => {
            if (!items) return;
            const q = search.value.trim().toLowerCase();
            const shown = items.filter((p) => !q || p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
            list.innerHTML = shown.length
                ? shown
                      .map((p) => {
                          const n = picked.indexOf(p.id);
                          return `<button type="button" class="rm-clishe-item${n >= 0 ? ' is-picked' : ''}" data-id="${escapeHtml(p.id)}">
                            <span class="rm-clishe-mark">${n >= 0 ? n + 1 : ''}</span>
                            <span class="rm-clishe-text"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.text.replace(/\s+/g, ' '))}</span></span>
                        </button>`;
                      })
                      .join('')
                : `<div class="rm-clishe-empty">${items.length ? 'Ничего не найдено' : 'Клише пока нет'}</div>`;
            count.textContent = picked.length
                ? `Выбрано: ${picked.length}${picked.length > 1 ? ' — вставятся списком' : ''}`
                : 'Нажмите на клише, чтобы выбрать';
            insert.disabled = !picked.length;
        };

        const load = async (force) => {
            ensureAnalyzerStyles();
            list.innerHTML = '<div class="rm-clishe-empty"><span class="release-ai-spinner"></span> Загружаю клише…</div>';
            try {
                items = await loadClishe(force);
                // выбранные клише могли удалить на сайте
                for (let i = picked.length - 1; i >= 0; i--) if (!items.some((p) => p.id === picked[i])) picked.splice(i, 1);
                render();
            } catch (err) {
                items = null;
                list.innerHTML = `<div class="rm-clishe-empty is-error">Не удалось загрузить клише: ${escapeHtml(err.message || err)}
                    <button type="button" class="rm-clishe-retry">Повторить</button></div>`;
            }
        };

        const hide = () => {
            box.hidden = true;
            toggle.classList.remove('is-open');
        };

        toggle.addEventListener('click', () => {
            if (!box.hidden) return hide();
            box.hidden = false;
            toggle.classList.add('is-open');
            search.focus();
            if (!items) load(false);
            else render();
        });
        search.addEventListener('input', render);
        // Модератор ушёл править клише на сайт — когда вернётся на вкладку, подтягиваем свежий список.
        manage.addEventListener('click', () => {
            clisheCache = null;
            window.addEventListener('focus', () => {
                if (root.isConnected && !box.hidden) load(true);
                else items = null;
            }, { once: true });
        });
        list.addEventListener('click', (e) => {
            if (e.target.closest('.rm-clishe-retry')) return load(true);
            const item = e.target.closest('.rm-clishe-item');
            if (!item) return;
            const i = picked.indexOf(item.dataset.id);
            if (i >= 0) picked.splice(i, 1);
            else picked.push(item.dataset.id);
            render();
        });
        insert.addEventListener('click', () => {
            const chosen = picked.map((id) => items.find((p) => p.id === id)).filter(Boolean);
            if (!chosen.length) return;
            // между пунктами — одна пустая строка
            onInsert(chosen.length > 1 ? chosen.map((p, i) => `${i + 1}. ${p.text}`).join('\n\n') : chosen[0].text);
            picked.length = 0;
            search.value = '';
            hide();
        });

        return { box, hide };
    }

    function openDecisionModal(info) {
        document.querySelector('.rm-modal-overlay')?.remove();

        const problem = !info.id
            ? 'Не нашёл id релиза в строке.'
            : info.kind === 'album' && !info.albumNum
              ? 'Не нашёл номер альбома в строке.'
              : !info.login
                ? 'Не нашёл логин артиста в строке.'
                : '';
        const canSubmit = !problem;

        const texts = { reject: '', rights: rightsTemplate(info.login, info.title, info.kind) };
        let mode = 'reject';
        let busy = false;
        let statusDone = false; // статус уже сменён — повтор отправляет только комментарий

        const overlay = document.createElement('div');
        overlay.className = 'rm-modal-overlay';
        overlay.innerHTML = `
            <div class="rm-modal" role="dialog" aria-modal="true">
                <div class="rm-modal__head">
                    <div class="rm-modal__title">Решение по релизу</div>
                    <div class="rm-modal__sub">${escapeHtml(info.title || '—')}${info.login ? ` · @${escapeHtml(info.login)}` : ''}</div>
                </div>
                <div class="rm-modal__body">
                    <div class="rm-modal-toolbar">
                        <div class="rm-modal-seg">
                            <button type="button" data-mode="reject">Отклонить</button>
                            <button type="button" data-mode="rights">Подтверждение прав</button>
                        </div>
                        <button type="button" class="rm-clishe-toggle">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5.6a1 1 0 0 1 .7.3l5.4 5.4a1 1 0 0 1 .3.7V19a2 2 0 0 1-2 2z"/></svg>
                            Клише
                        </button>
                    </div>
                    <div class="rm-clishe" hidden>
                        <div class="rm-clishe-searchbar">
                            <input type="text" class="rm-clishe-search" placeholder="Поиск клише…">
                            <a class="rm-clishe-manage" href="${CLISHE_MANAGE_URL}" target="_blank" rel="noopener" title="Сайт для добавления, изменения и порядка клише">Добавить / изменить ↗</a>
                        </div>
                        <div class="rm-clishe-list"></div>
                        <div class="rm-clishe-foot">
                            <span class="rm-clishe-count"></span>
                            <button type="button" class="rm-clishe-insert" disabled>Вставить</button>
                        </div>
                    </div>
                    <div class="rm-modal__prefix"></div>
                    <textarea></textarea>
                    <div class="rm-modal__status"></div>
                </div>
                <div class="rm-modal__foot">
                    <button type="button" class="rm-modal__cancel">Отмена</button>
                    <button type="button" class="rm-modal__primary"></button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const ta = overlay.querySelector('textarea');
        const prefix = overlay.querySelector('.rm-modal__prefix');
        const primary = overlay.querySelector('.rm-modal__primary');
        const statusEl = overlay.querySelector('.rm-modal__status');
        const setStatus = (text, isError) => {
            statusEl.textContent = text;
            statusEl.classList.toggle('is-error', !!isError);
        };

        const render = () => {
            overlay.querySelectorAll('.rm-modal-seg button').forEach((b) => {
                b.classList.toggle('is-active', b.dataset.mode === mode);
                b.disabled = statusDone;
            });
            prefix.style.display = mode === 'reject' ? '' : 'none';
            prefix.textContent = rejectPrefix(info.login);
            ta.value = texts[mode];
            ta.placeholder = mode === 'reject' ? 'Причина отклонения…' : '';
            primary.classList.toggle('is-rights', mode === 'rights');
            primary.textContent = statusDone
                ? 'Отправить комментарий ещё раз'
                : mode === 'reject'
                  ? 'Отклонить релиз'
                  : 'Запросить подтверждение прав';
        };

        const submit = async () => {
            if (busy || !canSubmit) return;
            const body = texts[mode].trim();
            if (!body) {
                setStatus(mode === 'reject' ? 'Укажите причину отклонения.' : 'Комментарий пустой.', true);
                ta.focus();
                return;
            }
            const comment = mode === 'reject' ? `${rejectPrefix(info.login)} ${body}` : body;

            busy = true;
            primary.disabled = true;
            ta.disabled = true;
            try {
                if (!statusDone) {
                    setStatus('Меняю статус…');
                    await saveReleaseStatus(info, DECISION_STATUS[mode]);
                    statusDone = true;
                }
                setStatus('Отправляю комментарий…');
                await postReleaseComment(info, comment);
                setStatus('Готово, обновляю страницу…');
                setTimeout(() => location.reload(), 500);
            } catch (err) {
                busy = false;
                primary.disabled = false;
                ta.disabled = false;
                render();
                setStatus(
                    (statusDone ? 'Статус изменён, но комментарий не отправился: ' : 'Ошибка, статус не изменён: ') +
                        (err.message || err),
                    true
                );
            }
        };

        const onKey = (e) => {
            if (e.key === 'Escape') {
                if (!clishe.box.hidden) clishe.hide();
                else close();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        };
        const close = () => {
            if (busy) return;
            overlay.remove();
            document.removeEventListener('keydown', onKey);
        };

        ta.addEventListener('input', () => {
            texts[mode] = ta.value;
        });
        overlay.querySelectorAll('.rm-modal-seg button').forEach((b) =>
            b.addEventListener('click', () => {
                if (busy || statusDone) return;
                mode = b.dataset.mode;
                render();
                ta.focus();
            })
        );
        overlay.addEventListener('click', (e) => e.target === overlay && close());
        overlay.querySelector('.rm-modal__cancel').addEventListener('click', close);
        primary.addEventListener('click', submit);
        document.addEventListener('keydown', onKey);

        const clishe = bindClishePanel(overlay, (block) => {
            const current = ta.value.replace(/\s+$/, '');
            ta.value = current ? `${current}\n${block}` : block;
            texts[mode] = ta.value;
            ta.focus();
            ta.setSelectionRange(ta.value.length, ta.value.length);
        });

        render();
        if (!canSubmit) {
            primary.disabled = true;
            setStatus(problem, true);
        }
        ta.focus();
    }

    function polishSongRows() {
        if (!document.body.classList.contains('rm-songs')) return;

        document.querySelectorAll('.table-responsive1 tbody tr[id]').forEach((row) => {
            if (row.dataset.rmPolished) return;
            row.dataset.rmPolished = '1';

            // Ширины колонок стоят в style="…!important" — стилями их не перебить.
            row.querySelectorAll(':scope > td').forEach((td) => td.style.removeProperty('width'));

            const next = row.nextElementSibling;
            if (
                next &&
                !next.id &&
                !next.classList.contains('release-comments-row') &&
                (next.querySelector('td')?.textContent || '').trim().startsWith('Распознание')
            ) {
                next.classList.add('rm-recog');
                polishRecognitionRow(next);
            }

            const actionsTd = row.querySelector('td:nth-child(10)');
            if (actionsTd && !actionsTd.querySelector('.rm-reject-btn')) {
                const rejectBtn = document.createElement('button');
                rejectBtn.type = 'button';
                rejectBtn.className = 'rm-reject-btn';
                rejectBtn.textContent = 'Отклонить';
                rejectBtn.addEventListener('click', () => openDecisionModal(getSongRowInfo(row)));
                actionsTd.appendChild(rejectBtn);
            }

            const main = row.querySelector('td:nth-child(4)');
            if (!main) return;

            // Ячейка названия: «Название <br><br> Артисты: …<br>Автор: …<br><br> <audio> [детали]».
            let title = '';
            let artists = '';
            let author = '';
            let audio = null;
            let details = null;
            const extras = [];
            Array.from(main.childNodes).forEach((n) => {
                if (n.nodeType === 3) {
                    const t = n.textContent.replace(/\s+/g, ' ').trim();
                    if (!t) return;
                    if (/^Артисты:/i.test(t)) artists = t.replace(/^Артисты:\s*/i, '');
                    else if (/^Автор:/i.test(t)) author = t.replace(/^Автор:\s*/i, '');
                    else if (!title) title = t;
                    else extras.push(document.createTextNode(t));
                } else if (n.nodeType === 1 && n.tagName !== 'BR') {
                    if (n.tagName === 'AUDIO') audio = n;
                    else if (n.classList.contains('release-inline-details')) details = n;
                    else extras.push(n);
                }
            });
            row.dataset.rmArtists = artists;
            row.dataset.rmAuthor = author;

            const meta = buildMetaWrap(row, 5, 8);
            main.textContent = '';

            const titleEl = document.createElement('p');
            titleEl.className = 'rm-title';
            titleEl.textContent = title || '—';
            main.append(titleEl, meta);

            if (extras.length) {
                const ex = document.createElement('div');
                ex.className = 'rm-extra';
                ex.append(...extras);
                main.appendChild(ex);
            }

            const slot = document.createElement('div');
            slot.className = 'rm-details-slot';
            if (details) slot.appendChild(details);
            main.appendChild(slot);

            // Плеер — в одну строку с «Проверкой ИИ» (ячейка AI). Иконку ИИ и кнопку текста не двигаем:
            // enhanceAiColumn потом ищет их именно в этой ячейке.
            if (audio) {
                const aw = document.createElement('div');
                aw.className = 'rm-audio';
                aw.appendChild(audio);
                (row.querySelector('td:nth-child(9)') || main).prepend(aw);
                upgradeAudio(audio);
            }
        });
    }

    /* =====================================================
              УДАЛЕНИЕ КНОПКИ «в очередь через Звонко»
    ===================================================== */

    function removeZvonkoButtons() {
        // Только на странице синглов (manage-songs).
        if (!location.pathname.includes('/admin-cp/manage-songs')) return;
        // Удаляем ТОЛЬКО кнопку Звонко (она в одной форме с «Добавить в очередь»,
        // поэтому форму трогать нельзя).
        document.querySelectorAll('input[name="add_queue_zvonko"]').forEach((input) => {
            input.remove();
        });
    }

    /* =====================================================
              ЗЕЛЁНАЯ КНОПКА «Добавить в очередь»
    ===================================================== */

    function ensureQueueButtonStyles() {
        if (document.getElementById('release-queue-btn-styles')) return;
        const style = document.createElement('style');
        style.id = 'release-queue-btn-styles';
        style.textContent = `
            .release-queue-btn {
                background-color:#43a047 !important;
                color:#fff !important;
                border:none !important;
                border-radius:2px !important;
                box-shadow:0 2px 5px rgba(0,0,0,0.16), 0 2px 10px rgba(0,0,0,0.12) !important;
                font-size:13px !important;
                line-height:1.42857143 !important;
                padding:6px 12px !important;
                margin-bottom:0 !important;
                cursor:pointer;
            }
            .release-queue-btn:hover,
            .release-queue-btn:focus,
            .release-queue-btn:active {
                background-color:#388e3c !important;
                color:#fff !important;
            }
        `;
        document.head.appendChild(style);
    }

    function styleQueueButtons() {
        const btns = document.querySelectorAll('input[name="add_queue"]');
        if (!btns.length) return;
        ensureQueueButtonStyles();
        btns.forEach((btn) => {
            if (btn.classList.contains('release-queue-btn')) return;
            btn.classList.add('release-queue-btn', 'waves-effect', 'waves-light');
            if (btn.value) btn.value = 'Добавить в очередь';
        });
    }

    function addAlbumQueueButton(row, editId) {
        if (!editId) return;
        const delBtn = row.querySelector('button.btn-delete-album');
        if (!delBtn) return;
        if (delBtn.parentElement.querySelector('.release-album-queue-btn')) return;

        ensureQueueButtonStyles();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'release-album-queue-btn release-queue-btn waves-effect waves-light';
        btn.style.cssText = 'margin-top:8px;';
        btn.textContent = 'Добавить в очередь';
        btn.addEventListener('click', () => queueAlbum(btn, editId, row));

        // На отдельной строке под «Удалить», выровнено слева.
        delBtn.insertAdjacentElement('afterend', btn);
        delBtn.insertAdjacentElement('afterend', document.createElement('br'));
    }

    function getAlbumArtistLogin(row) {
        const a = row.querySelector('td:nth-child(3) a[href*="/media/"]');
        const href = a?.getAttribute('href') || '';
        const m = href.match(/\/media\/([^/?#]+)/i);
        return m?.[1] || '';
    }

    async function queueAlbum(btn, editId, row) {
        if (btn.dataset.busy || btn.dataset.done) return;
        btn.dataset.busy = '1';
        btn.style.opacity = '0.7';
        btn.textContent = 'Добавляю…';

        try {
            // 1) Добавление в очередь
            const res = await fetch(`https://rumedia.io/media/edit-album/${editId}`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ add_queue: 'Добавить в очередь' }).toString(),
            });
            if (!res.ok) throw new Error('HTTP ' + res.status);

            // 2) Автокомментарий артисту
            const hashId = document.querySelector('.main_session')?.value || '';
            const albumId = row?.id || '';
            const login = getAlbumArtistLogin(row);
            if (hashId && albumId) {
                const value = `@${login} Ваш релиз прошел модерацию и был отправлен на площадки`;
                await fetch('https://rumedia.io/media/endpoints/register-comment', {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: new URLSearchParams({
                        hash_id: hashId,
                        id: '0',
                        value,
                        timePercentage: '',
                        time: '',
                        wave: '0',
                        album_id: albumId,
                    }).toString(),
                }).catch(() => {});
            }

            btn.dataset.busy = '';
            btn.dataset.done = '1';
            btn.disabled = true;
            btn.style.opacity = '1';
            btn.style.backgroundColor = '#2e7d32';
            btn.textContent = '✓ В очереди';

            // Обновляем страницу, чтобы список подтянул актуальный статус.
            setTimeout(() => location.reload(), 600);
        } catch (e) {
            btn.dataset.busy = '';
            btn.style.opacity = '1';
            btn.textContent = 'Ошибка — повторить';
        }
    }

    /* =====================================================
                        OBSERVER
    ===================================================== */

    function observeTable() {
        const table = document.querySelector('.table-responsive1, table.table');
        if (!table) return;

        new MutationObserver(() => {
            processForms();
            processAlbumRows();
            polishAlbumRows();
            polishSongRows();
            enhanceAlbumEditor();
        }).observe(table, { childList: true, subtree: true });
    }

    /* =====================================================
                        READY
    ===================================================== */

    function ready(fn) {
        if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', fn);
        else fn();
    }

    /* =====================================================
                        INIT
    ===================================================== */

    ready(() => {
        // Во вложенных окнах (скрытое edit-album / edit-track при «Отклонить») не запускаемся:
        // иначе там зря грузились бы треки и шёл ИИ-анализ.
        if (window.self !== window.top) return;
        ensureThemeTokens();
        document.addEventListener('click', onCommentsExpandClick);
        applyAlbumsRedesign();
        applySongsRedesign();
        processForms();
        processAlbumRows();
        enhanceAlbumEditor();
        removeZvonkoButtons();
        styleQueueButtons();
        observeTable();
        enableCoverZoom();
    });
})();
