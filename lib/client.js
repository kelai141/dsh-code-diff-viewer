window.__ModuleLoader__.load({
  id: "dsh-code-diff-viewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    // —— 模块级状态：跨卡片共享，仅存在于本次页面会话中 ——
    const seenCalls = new Set();
    const locateCache = new Map();

    // —— Host 定位：POST /cdv-locate 返回 hunk 绝对起始行号（1-based），找不到则 null ——
    function locateHunk(path, newText) {
      if (!path || !newText) return Promise.resolve(null);
      const key = path + "\u0000" + newText;
      if (locateCache.has(key)) return Promise.resolve(locateCache.get(key));
      const p = fetch("/cdv-locate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, needle: newText })
      }).then((r) => (r.ok ? r.json() : null)).then((j) => {
        const s = j && typeof j.start === "number" ? j.start : null;
        locateCache.set(key, s);
        return s;
      }).catch(() => {
        locateCache.set(key, null);
        return null;
      });
      locateCache.set(key, p);
      return p.then((s) => s);
    }

    // —— 语法高亮：按扩展名分组的轻量分词器 ——
    const KW = {
      js: 'const|let|var|function|return|if|else|for|while|do|class|extends|import|export|from|new|type|interface|enum|async|await|try|catch|finally|throw|switch|case|default|break|continue|typeof|instanceof|in|of|this|super|void|delete|yield|static|readonly|public|private|protected|get|set|implements|keyof|as|true|false|null|undefined|declare|abstract|namespace|satisfies|using',
      py: 'def|return|if|elif|else|for|while|import|from|as|class|try|except|finally|with|lambda|pass|break|continue|global|nonlocal|raise|assert|yield|in|is|not|and|or|True|False|None|async|await|del|self|match|case',
      css: '!important|@import|@media|@keyframes|@font-face|@supports|@charset|@namespace|@layer|@container',
      sh: 'if|then|else|elif|fi|for|while|do|done|case|esac|function|return|local|export|source|exit|echo|cd|pwd|ls|mkdir|rm|cp|mv|touch|cat|grep|sed|awk|curl|wget|git|npm|pnpm|yarn|node|python|pip|sudo|apt|chmod|chown|tar|unzip|zip|ps|kill|set|shift|trap|read|test|printf|alias|declare',
      json: 'true|false|null',
      yml: 'true|false|null|yes|no|on|off',
      md: '',
      txt: ''
    };

    const GROUP_BY_EXT = {
      js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
      py: 'py', css: 'css', scss: 'css', less: 'css', html: 'html', htm: 'html', xml: 'html', vue: 'html', svg: 'html',
      sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', json: 'json', md: 'md', yml: 'yml', yaml: 'yml', toml: 'yml'
    };

    const reCache = new Map();

    function groupOf(path) {
      const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ''));
      if (!m) return 'txt';
      return GROUP_BY_EXT[m[1].toLowerCase()] || 'txt';
    }

    function lineRe(group) {
      const cached = reCache.get(group);
      if (cached) return cached;
      const kws = (KW[group] || '').split('|').filter(Boolean);
      const kwAlt = kws.length ? '\\b(' + kws.join('|') + ')\\b' : '(?!)';
      const parts = [];
      if (group === 'py' || group === 'sh' || group === 'yml') parts.push('(#[^\\n]*)');
      else if (group === 'js' || group === 'json') parts.push('(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)');
      else if (group === 'css') parts.push('(\\/\\*[\\s\\S]*?\\*\\/)');
      else parts.push('(?!)');
      parts.push('("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\\\n]|\\\\.)*`)');
      parts.push(group === 'html' ? '(<\\/?[A-Za-z][^<>\\n]*?\\/?>)' : '(?!)');
      parts.push('(\\b\\d+(?:\\.\\d+)?\\b)');
      parts.push(kwAlt);
      parts.push('([A-Za-z_$][\\w$]*)(?=\\s*:)');
      parts.push('([A-Za-z_$][\\w$]*)');
      const re = new RegExp(parts.join('|'), 'g');
      reCache.set(group, re);
      return re;
    }

    function tokenizeLine(line, group) {
      const re = lineRe(group);
      re.lastIndex = 0;
      const out = [];
      let last = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m.index > last) out.push({ text: line.slice(last, m.index), cls: 'id' });
        let cls = 'id';
        if (m[1] !== undefined) cls = 'cm';
        else if (m[2] !== undefined) cls = 'st';
        else if (m[3] !== undefined) cls = 'tg';
        else if (m[4] !== undefined) cls = 'nu';
        else if (m[5] !== undefined) cls = 'kw';
        else if (m[6] !== undefined) cls = 'pr';
        else if (m[7] !== undefined) cls = /^[A-Z]/.test(m[7]) ? 'tp' : 'id';
        out.push({ text: m[0], cls });
        last = re.lastIndex;
      }
      if (last < line.length) out.push({ text: line.slice(last), cls: 'id' });
      return out;
    }

    // —— 从工具调用数据里提取 before/after ——
    function parseArgs(raw) {
      if (typeof raw !== 'string') return null;
      try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : null;
      } catch (e) {
        return null;
      }
    }

    function textOf(block) {
      const c = block && Array.isArray(block.content) ? block.content : [];
      const parts = [];
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
      return parts.join('\n');
    }

    function sanitizeDiffs(diffs) {
      if (!Array.isArray(diffs)) return [];
      const out = [];
      for (const d of diffs) {
        if (!d || typeof d !== 'object') continue;
        if (typeof d.path !== 'string') continue;
        if (d.oldText !== null && typeof d.oldText !== 'string') continue;
        if (typeof d.newText !== 'string') continue;
        out.push({ path: d.path, oldText: d.oldText, newText: d.newText });
      }
      return out;
    }

    function argsHunk(toolName, args) {
      if (!args) return null;
      const path = typeof args.file_path === 'string' ? args.file_path : '';
      if (!path) return null;
      if (toolName === 'edit') {
        return { path, oldText: typeof args.old_string === 'string' ? args.old_string : '', newText: typeof args.new_string === 'string' ? args.new_string : '' };
      }
      if (toolName === 'write') {
        return { path, oldText: null, newText: typeof args.content === 'string' ? args.content : '' };
      }
      return null;
    }

    function isPatchTool(toolName) {
      return toolName === 'apply_patch' || toolName === 'apply-patch' || toolName === 'applypatch';
    }

    function buildModel(block, toolName) {
      if (!block || typeof block !== 'object') return { state: 'done', hunks: [], errorText: '', fullFileDiff: false };
      const running = !('kind' in block);
      if (running) {
        const view = block.callView && block.callView.card === 'diff' ? block.callView : null;
        if (view) {
          const diffs = sanitizeDiffs(view.diffs);
          if (diffs.length) return { state: 'running', hunks: diffs, errorText: '', fullFileDiff: false };
        }
        const hunk = argsHunk(toolName, parseArgs(block.argsRaw));
        return { state: 'running', hunks: hunk ? [hunk] : [], errorText: '', fullFileDiff: false };
      }
      if (block.isError) {
        return { state: 'error', hunks: [], errorText: textOf(block), fullFileDiff: false };
      }
      const view = block.resultView && block.resultView.card === 'diff' ? block.resultView : null;
      if (view) {
        const diffs = sanitizeDiffs(view.diffs);
        // Codex/GPT apply_patch 在完成时回传完整 before/after；它们已经带有文件绝对行号。
        if (diffs.length) return { state: 'done', hunks: diffs, errorText: '', fullFileDiff: isPatchTool(toolName) };
      }
      const args = block.call ? parseArgs(block.call.argsRaw) : null;
      const hunk = argsHunk(toolName, args);
      return { state: 'done', hunks: hunk ? [hunk] : [], errorText: textOf(block), fullFileDiff: false };
    }

    // —— 行级 diff 对齐（LCS + 前后缀裁剪 + 大文件降级）——
    function alignLines(oldLines, newLines) {
      const n = oldLines.length;
      const m = newLines.length;
      let start = 0;
      while (start < n && start < m && oldLines[start] === newLines[start]) start++;
      let endOld = n;
      let endNew = m;
      while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) { endOld--; endNew--; }
      const pairs = [];
      for (let i = 0; i < start; i++) pairs.push({ a: i, b: i, kind: 'same' });
      const mid = lcsPairs(oldLines.slice(start, endOld), newLines.slice(start, endNew), start);
      for (const p of mid) pairs.push(p);
      const tail = n - endOld;
      for (let i = 0; i < tail; i++) pairs.push({ a: endOld + i, b: endNew + i, kind: 'same' });
      return mergeMods(pairs);
    }

    function lcsPairs(a, b, base) {
      const n = a.length;
      const m = b.length;
      if (n === 0 && m === 0) return [];
      if (n * m > 4000000) return zipFallback(a, b, base);
      const w = m + 1;
      const dp = new Uint32Array((n + 1) * w);
      for (let i = 1; i <= n; i++) {
        const ai = a[i - 1];
        const row = i * w;
        const prev = row - w;
        for (let j = 1; j <= m; j++) {
          if (ai === b[j - 1]) dp[row + j] = dp[prev + j - 1] + 1;
          else dp[row + j] = dp[prev + j] >= dp[row + j - 1] ? dp[prev + j] : dp[row + j - 1];
        }
      }
      const out = [];
      let i = n;
      let j = m;
      while (i > 0 && j > 0) {
        if (a[i - 1] === b[j - 1]) { out.push({ a: i - 1 + base, b: j - 1 + base, kind: 'same' }); i--; j--; }
        else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) { out.push({ a: i - 1 + base, b: null, kind: 'del' }); i--; }
        else { out.push({ a: null, b: j - 1 + base, kind: 'add' }); j--; }
      }
      while (i > 0) { out.push({ a: i - 1 + base, b: null, kind: 'del' }); i--; }
      while (j > 0) { out.push({ a: null, b: j - 1 + base, kind: 'add' }); j--; }
      out.reverse();
      return out;
    }

    function zipFallback(a, b, base) {
      const out = [];
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        const hasA = i < a.length;
        const hasB = i < b.length;
        let kind = 'same';
        if (!hasA) kind = 'add';
        else if (!hasB) kind = 'del';
        else if (a[i] !== b[i]) kind = 'mod';
        out.push({ a: hasA ? i + base : null, b: hasB ? i + base : null, kind });
      }
      return out;
    }

    function mergeMods(pairs) {
      const out = [];
      let i = 0;
      while (i < pairs.length) {
        const p = pairs[i];
        if (p.kind === 'del' || p.kind === 'add') {
          let j = i;
          while (j < pairs.length && (pairs[j].kind === 'del' || pairs[j].kind === 'add')) j++;
          const dels = [];
          const adds = [];
          for (let t = i; t < j; t++) {
            if (pairs[t].kind === 'del') dels.push(pairs[t]);
            else adds.push(pairs[t]);
          }
          const k = Math.min(dels.length, adds.length);
          for (let t = 0; t < k; t++) out.push({ a: dels[t].a, b: adds[t].b, kind: 'mod' });
          for (let t = k; t < dels.length; t++) out.push({ a: dels[t].a, b: null, kind: 'del' });
          for (let t = k; t < adds.length; t++) out.push({ a: null, b: adds[t].b, kind: 'add' });
          i = j;
        } else {
          out.push(p);
          i++;
        }
      }
      return out;
    }

    // 与原厂 contentLines 相同的尾部换行规则：单个结尾换行是行终止符，不是额外空行
    function splitLines(text) {
      if (text === null || text === undefined) return [];
      let s = String(text).replace(/\r\n?/g, '\n');
      if (s.endsWith('\n')) s = s.slice(0, -1);
      return s.split('\n');
    }

    // 全文件 diff 只渲染变更周围的上下文；远处不变内容不进 DOM，避免大文件 LCS 后仍因大量渲染而卡顿。
    function visibleEntries(pairs) {
      const context = 3;
      const maxRowsPerWindow = 160;
      const changed = [];
      for (let i = 0; i < pairs.length; i++) if (pairs[i].kind !== 'same') changed.push(i);
      if (!changed.length) return pairs.map((pair) => ({ pair }));

      const windows = [];
      let from = Math.max(0, changed[0] - context);
      let to = Math.min(pairs.length - 1, changed[0] + context);
      for (let i = 1; i < changed.length; i++) {
        const nextFrom = Math.max(0, changed[i] - context);
        const nextTo = Math.min(pairs.length - 1, changed[i] + context);
        if (nextFrom <= to + 1) {
          to = Math.max(to, nextTo);
        } else {
          windows.push({ from, to });
          from = nextFrom;
          to = nextTo;
        }
      }
      windows.push({ from, to });

      const entries = [];
      function appendWindow(start, end) {
        const count = end - start + 1;
        if (count <= maxRowsPerWindow) {
          for (let i = start; i <= end; i++) entries.push({ pair: pairs[i] });
          return;
        }
        const edge = Math.floor(maxRowsPerWindow / 2);
        for (let i = start; i < start + edge; i++) entries.push({ pair: pairs[i] });
        entries.push({ gap: count - edge * 2, folded: true });
        for (let i = end - edge + 1; i <= end; i++) entries.push({ pair: pairs[i] });
      }
      let previousEnd = -1;
      for (const window of windows) {
        if (previousEnd >= 0 && window.from > previousEnd + 1) entries.push({ gap: window.from - previousEnd - 1, folded: false });
        appendWindow(window.from, window.to);
        previousEnd = window.to;
      }
      return entries;
    }

    function hunkRows(hunk, absoluteLineNumbers) {
      const oldLines = splitLines(hunk.oldText);
      const newLines = splitLines(hunk.newText);
      const pairs = alignLines(oldLines, newLines);
      const entries = visibleEntries(pairs);
      const left = [];
      const right = [];
      let adds = 0;
      let dels = 0;
      for (const p of pairs) {
        if (p.kind !== 'same') {
          if (p.kind === 'add' || p.kind === 'mod') adds++;
          if (p.kind === 'del' || p.kind === 'mod') dels++;
        }
      }
      let oldBase = 0;
      let newBase = 0;
      for (const entry of entries) {
        if (!entry.pair) continue;
        if (entry.pair.a !== null) { oldBase = entry.pair.a; break; }
      }
      for (const entry of entries) {
        if (!entry.pair) continue;
        if (entry.pair.b !== null) { newBase = entry.pair.b; break; }
      }
      for (const entry of entries) {
        if (entry.gap) {
          const label = '… ' + entry.gap + ' 行' + (entry.folded ? '已折叠' : '未变更') + ' …';
          left.push({ num: null, text: label, kind: 'gap', sign: '' });
          right.push({ num: null, text: label, kind: 'gap', sign: '' });
          continue;
        }
        const p = entry.pair;
        // 始终成对 push：删除/新增导致左右行数不一致时，用空占位行补齐，
        // 避免某一侧出现“空一块”，保证左右行与行之间对齐。
        if (p.a !== null) {
          left.push({ num: absoluteLineNumbers ? p.a + 1 : p.a - oldBase + 1, text: oldLines[p.a], kind: p.kind === 'same' ? 'same' : p.kind === 'mod' ? 'mod' : 'del', sign: p.kind === 'same' ? '' : '−' });
        } else {
          // 对侧新增时保留同高的淡绿色占位，既维持行对齐，也不会留下难以理解的纯黑空白。
          left.push({ num: null, text: '', kind: 'placeholder-add', sign: '' });
        }
        if (p.b !== null) {
          right.push({ num: absoluteLineNumbers ? p.b + 1 : p.b - newBase + 1, text: newLines[p.b], kind: p.kind === 'same' ? 'same' : p.kind === 'mod' ? 'mod' : 'add', sign: p.kind === 'same' ? '' : '+' });
        } else {
          // 对侧删除时保留同高的淡红色占位，既维持行对齐，也不会留下难以理解的纯黑空白。
          right.push({ num: null, text: '', kind: 'placeholder-del', sign: '' });
        }
      }
      // 普通 edit/write hunk 仍通过首个可见的 after 片段反查绝对行号；完整 apply_patch 直接使用原始行号。
      const locatorText = absoluteLineNumbers ? '' : newLines.slice(newBase, Math.min(newLines.length, newBase + 12)).join('\n');
      return { left, right, adds, dels, locatorText, absoluteLineNumbers };
    }

    function relPath(path, cwd) {
      if (!cwd || !path) return path;
      const c = String(cwd).replace(/\\/g, '/');
      const p = String(path).replace(/\\/g, '/');
      if (p === c) return path;
      if (p.indexOf(c + '/') === 0) return p.slice(c.length + 1);
      return path;
    }

    // 标题只保留最能识别文件的末两级路径；完整路径仍可通过原生提示查看和点击打开。
    function shortPath(path, cwd) {
      const p = String(relPath(path, cwd) || '').replace(/\\/g, '/');
      const parts = p.split('/').filter(Boolean);
      return parts.length > 2 ? parts.slice(-2).join('/') : p;
    }

    // —— React 渲染 ——
    function CodePanel(props) {
      const { title, isNew, rows, group, empty, offset, codesRef, onCodesScroll, compact } = props;
      const children = [];
      if (rows.length) {
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          const toks = tokenizeLine(r.text, group);
          children.push(React.createElement('div', { className: 'cdv-line cdv-' + r.kind, key: i },
            React.createElement('span', { className: 'cdv-gutter' },
              React.createElement('span', { className: 'cdv-sign' }, r.sign),
              React.createElement('span', { className: 'cdv-num' }, r.num == null ? '' : r.num + (offset || 0))
            ),
            React.createElement('span', { className: 'cdv-codetext', title: compact && r.text ? r.text : undefined },
              toks.map((t, j) => React.createElement('span', { className: 'cdv-tok cdv-tok-' + t.cls, key: j }, t.text))
            )
          ));
        }
      } else {
        children.push(React.createElement('div', { className: 'cdv-empty', key: 'e' }, empty));
      }
      return React.createElement('div', { className: 'cdv-col' + (isNew ? ' cdv-col-new' : '') },
        React.createElement('div', { className: 'cdv-col-head' }, title),
        React.createElement('div', { className: 'cdv-codes' + (compact ? ' cdv-codes-compact' : ''), ref: codesRef, onScroll: onCodesScroll }, children)
      );
    }

    function EditWriteView(props) {
      const { toolName, block, cwd, openFile } = props;
      const callId = block && block.callId ? block.callId : 'call';
      const [open, setOpen] = React.useState(false);
      React.useEffect(() => {
        if (!seenCalls.has(callId)) {
          seenCalls.add(callId);
          setOpen(true);
        }
      }, [callId]);

      const model = buildModel(block, toolName);
      const path = model.hunks.length ? model.hunks[0].path : '';
      const hunks = [];
      let adds = 0;
      let dels = 0;
      for (let i = 0; i < model.hunks.length; i++) {
        const h = model.hunks[i];
        const rows = hunkRows(h, model.fullFileDiff);
        adds += rows.adds;
        dels += rows.dels;
        hunks.push({ path: h.path, group: groupOf(h.path), left: rows.left, right: rows.right, adds: rows.adds, dels: rows.dels, locatorText: rows.locatorText, absoluteLineNumbers: rows.absoluteLineNumbers });
      }

      // —— 左右滚动同步：长内容横向滚动时保持两列对齐 ——
      const codesRefs = React.useRef({});
      const syncingRef = React.useRef(false);
      function syncCodes(source, hunkIndex, side) {
        if (syncingRef.current) return;
        const otherSide = side === 'new' ? 'old' : 'new';
        const other = codesRefs.current[hunkIndex + ':' + otherSide];
        if (other && other !== source) {
          syncingRef.current = true;
          other.scrollLeft = source.scrollLeft;
          other.scrollTop = source.scrollTop;
          setTimeout(function () { syncingRef.current = false; }, 0);
        }
      }

      // —— 绝对行号定位：settled 后向 Host 反推每个 hunk 的起始行 ——
      const [locStarts, setLocStarts] = React.useState(null);
      const sig = model.state === 'done' && hunks.length ? hunks.map((h) => h.absoluteLineNumbers ? '' : h.path + '\u0000' + h.locatorText).join('|') : '';
      React.useEffect(() => {
        if (!sig) {
          setLocStarts(null);
          return;
        }
        let alive = true;
        Promise.all(hunks.map((h, i) => h.absoluteLineNumbers || !h.locatorText ? Promise.resolve([i, null]) : locateHunk(h.path, h.locatorText).then((s) => [i, s]))).then((res) => {
          if (!alive) return;
          const arr = [];
          for (const [i, s] of res) arr[i] = s;
          setLocStarts(arr);
        });
        return () => {
          alive = false;
        };
      }, [sig]);

      let body = null;
      if (open) {
        if (hunks.length) {
          body = React.createElement('div', { className: 'cdv-body' },
            hunks.map((h, i) => {
              const offset = h.absoluteLineNumbers ? 0 : locStarts && typeof locStarts[i] === 'number' ? locStarts[i] - 1 : 0;
              const both = h.adds > 0 && h.dels > 0;
              const compact = h.group === 'md';
              let cols = null;
              if (both) {
                cols = [
                  React.createElement(CodePanel, {
                    key: 'a', title: '修改前', isNew: false, rows: h.left, group: h.group, empty: '（无内容）', offset, compact,
                    codesRef: function (el) { if (el) codesRefs.current[i + ':old'] = el; else delete codesRefs.current[i + ':old']; },
                    onCodesScroll: function (e) { syncCodes(e.currentTarget, i, 'old'); }
                  }),
                  React.createElement(CodePanel, {
                    key: 'b', title: '修改后', isNew: true, rows: h.right, group: h.group, empty: '（无内容）', offset, compact,
                    codesRef: function (el) { if (el) codesRefs.current[i + ':new'] = el; else delete codesRefs.current[i + ':new']; },
                    onCodesScroll: function (e) { syncCodes(e.currentTarget, i, 'new'); }
                  })
                ];
              } else if (h.adds > 0) {
                cols = React.createElement(CodePanel, { title: '新增', isNew: true, rows: h.right, group: h.group, empty: '（无内容）', offset, compact });
              } else if (h.dels > 0) {
                cols = React.createElement(CodePanel, { title: '删除', isNew: false, rows: h.left, group: h.group, empty: '（无内容）', offset, compact });
              } else {
                cols = React.createElement(CodePanel, { title: '修改前', isNew: false, rows: h.left, group: h.group, empty: '（无实际变更）', offset, compact });
              }
              return React.createElement('div', { className: 'cdv-hunk', key: i },
                hunks.length > 1 ? React.createElement('div', { className: 'cdv-hunk-path' }, h.path + ' · 第 ' + (i + 1) + ' 处变更') : null,
                React.createElement('div', { className: 'cdv-cols' }, cols)
              );
            })
          );
        } else {
          const msg = model.state === 'error' ? (model.errorText || '执行失败') : model.state === 'running' ? '执行中…' : '（无代码变更）';
          body = React.createElement('div', { className: 'cdv-body' },
            React.createElement('div', { className: 'cdv-empty cdv-empty-msg' }, msg.length > 240 ? msg.slice(0, 240) + '…' : msg)
          );
        }
      }

      const stateText = model.state === 'error' ? '失败' : model.state === 'running' ? '执行中…' : '完成';
      const titleText = toolName === 'write' ? 'Write' : toolName === 'apply_patch' || toolName === 'apply-patch' || toolName === 'applypatch' ? 'Apply patch' : 'Edit';

      return React.createElement('div', { className: 'cdv-card' + (model.state === 'error' ? ' cdv-err' : '') },
        React.createElement('div', { className: 'cdv-head', onClick: function () { setOpen(!open); } },
          React.createElement('span', { className: 'cdv-chev' + (open ? ' cdv-open' : '') }, '▸'),
          React.createElement('span', { className: 'cdv-title' }, titleText),
          path ? React.createElement('span', { className: 'cdv-path', title: path, onClick: function (e) { e.stopPropagation(); if (typeof openFile === 'function') openFile(path); } }, shortPath(path, cwd)) : null,
          React.createElement('span', { className: 'cdv-badge' },
            adds > 0 ? React.createElement('span', { className: 'cdv-badd' }, '+' + adds) : null,
            dels > 0 ? React.createElement('span', { className: 'cdv-bdel' }, '−' + dels) : null
          ),
          React.createElement('span', { className: 'cdv-state' }, stateText)
        ),
        body
      );
    }

    // —— 样式 ——
    const CSS = `
.cdv-card { border: 1px solid rgba(128,128,128,.28); border-radius: 10px; overflow: hidden; margin: 2px 0; background: rgba(128,128,128,.05); }
.cdv-head { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 8px 12px; cursor: pointer; user-select: none; color: inherit; font: inherit; }
.cdv-chev { display: inline-block; transition: transform .15s ease; color: rgba(128,128,128,.95); font-size: 10px; }
.cdv-chev.cdv-open { transform: rotate(90deg); }
.cdv-title { font-weight: 600; font-size: 13px; }
.cdv-path { min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #58a6ff; margin-left: 4px; font-weight: 400; }
.cdv-path:hover { text-decoration: underline; }
.cdv-badge { flex: none; display: flex; gap: 6px; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: rgba(128,128,128,.12); padding: 1px 8px; border-radius: 99px; }
.cdv-badd { color: #7ee787; }
.cdv-bdel { color: #ff7b72; }
.cdv-state { flex: none; font-size: 11px; color: rgba(128,128,128,.9); }
.cdv-card.cdv-err .cdv-head { color: #ff7b72; }
.cdv-body { border-top: 1px solid rgba(128,128,128,.16); }
.cdv-hunk + .cdv-hunk { border-top: 1px dashed rgba(128,128,128,.28); }
.cdv-hunk-path { font-size: 11px; color: rgba(128,128,128,.85); padding: 6px 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.cdv-cols { display: flex; align-items: stretch; }
.cdv-col { flex: 1 1 50%; min-width: 0; }
.cdv-col + .cdv-col { border-left: 1px solid rgba(128,128,128,.22); }
.cdv-col-head { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 11px; color: rgba(128,128,128,.85); background: rgba(128,128,128,.08); }
.cdv-col-head::before { content: ''; width: 5px; height: 5px; border-radius: 99px; background: #ff7b72; box-shadow: 0 0 0 2px rgba(248,81,73,.1); }
.cdv-col-new .cdv-col-head::before { background: #7ee787; box-shadow: 0 0 0 2px rgba(63,185,80,.1); }
.cdv-codes { display: block; overflow: auto; max-height: 340px; background: #0d1117; font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace; font-size: 12px; line-height: 1.55; color: #d4d4d4; }
.cdv-line { display: flex; white-space: pre; min-width: max-content; width: 100%; box-sizing: border-box; }
.cdv-gutter { flex: none; width: 4em; text-align: right; padding-right: .7em; color: rgba(255,255,255,.35); user-select: none; }
.cdv-sign { display: inline-block; width: 1.1em; text-align: center; }
.cdv-line.cdv-mod, .cdv-line.cdv-del { background: rgba(248,81,73,.12); }
.cdv-line.cdv-mod .cdv-sign, .cdv-line.cdv-del .cdv-sign { color: #ff7b72; }
.cdv-col-new .cdv-line.cdv-mod, .cdv-line.cdv-add { background: rgba(63,185,80,.12); }
.cdv-col-new .cdv-line.cdv-mod .cdv-sign, .cdv-line.cdv-add .cdv-sign { color: #7ee787; }
.cdv-line.cdv-placeholder-add { background: rgba(63,185,80,.055); }
.cdv-line.cdv-placeholder-del { background: rgba(248,81,73,.055); }
.cdv-line.cdv-gap { background: rgba(128,128,128,.06); color: rgba(255,255,255,.42); font-style: italic; }
.cdv-line.cdv-gap .cdv-codetext { padding-left: .3em; }
.cdv-codes-compact { overflow-x: hidden; }
.cdv-codes-compact .cdv-line { min-width: 0; }
.cdv-codes-compact .cdv-codetext { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.cdv-tok-kw { color: #569cd6; }
.cdv-tok-st { color: #98c379; }
.cdv-tok-nu { color: #9cdcfe; }
.cdv-tok-tp { color: #c586c0; }
.cdv-tok-tg { color: #e06c75; }
.cdv-tok-pr { color: #e6edf3; }
.cdv-tok-cm { color: #8b949e; font-style: italic; }
.cdv-tok-id { color: #d4d4d4; }
.cdv-empty { padding: 26px 16px; text-align: center; color: rgba(255,255,255,.45); font-size: 12px; }
.cdv-empty-msg { white-space: pre-wrap; word-break: break-all; }
`;

    const name = "code-diff-viewer";
    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(() => {
        const styleEl = document.createElement("style");
        styleEl.setAttribute("data-plugin-css", "code-diff-viewer");
        styleEl.textContent = CSS;
        document.head.append(styleEl);
        return () => {
          styleEl.remove();
        };
      });
      ctx.slots.inject("tool.call.toolview", function* () {
        yield ctx.slots.register({ name: "tool.call.toolview", key: "edit" }, EditWriteView);
        yield ctx.slots.register({ name: "tool.call.toolview", key: "write" }, EditWriteView);
        // Codex/GPT 适配层以 apply_patch（及兼容别名）提交修改，结果同样携带 card: "diff"。
        // 这些键必须由本组件接管，否则会回落为通用工具卡片而丢失可视化 diff。
        // @opentritium/dsh-codex-shim 也以默认 priority 0 注册 apply_patch；
        // 用更低的 -1 遮蔽它（lowest renders），同时消除同键同优先级的加载冲突。
        yield ctx.slots.register({ name: "tool.call.toolview", key: "apply_patch", priority: -1 }, EditWriteView);
        yield ctx.slots.register({ name: "tool.call.toolview", key: "apply-patch", priority: -1 }, EditWriteView);
        yield ctx.slots.register({ name: "tool.call.toolview", key: "applypatch", priority: -1 }, EditWriteView);
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
