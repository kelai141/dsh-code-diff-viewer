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

    function buildModel(block, toolName) {
      if (!block || typeof block !== 'object') return { state: 'done', hunks: [], errorText: '' };
      const running = !('kind' in block);
      if (running) {
        const view = block.callView && block.callView.card === 'diff' ? block.callView : null;
        if (view) {
          const diffs = sanitizeDiffs(view.diffs);
          if (diffs.length) return { state: 'running', hunks: diffs, errorText: '' };
        }
        const hunk = argsHunk(toolName, parseArgs(block.argsRaw));
        return { state: 'running', hunks: hunk ? [hunk] : [], errorText: '' };
      }
      if (block.isError) {
        return { state: 'error', hunks: [], errorText: textOf(block) };
      }
      const view = block.resultView && block.resultView.card === 'diff' ? block.resultView : null;
      if (view) {
        const diffs = sanitizeDiffs(view.diffs);
        if (diffs.length) return { state: 'done', hunks: diffs, errorText: '' };
      }
      const args = block.call ? parseArgs(block.call.argsRaw) : null;
      const hunk = argsHunk(toolName, args);
      return { state: 'done', hunks: hunk ? [hunk] : [], errorText: textOf(block) };
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

    function hunkRows(hunk) {
      const oldLines = splitLines(hunk.oldText);
      const newLines = splitLines(hunk.newText);
      const pairs = alignLines(oldLines, newLines);
      const left = [];
      const right = [];
      let adds = 0;
      let dels = 0;
      for (const p of pairs) {
        if (p.kind !== 'same') {
          if (p.kind === 'add' || p.kind === 'mod') adds++;
          if (p.kind === 'del' || p.kind === 'mod') dels++;
        }
        if (p.a !== null) {
          left.push({ num: p.a + 1, text: oldLines[p.a], kind: p.kind === 'same' ? 'same' : p.kind === 'mod' ? 'mod' : 'del', sign: p.kind === 'same' ? '' : '−' });
        }
        if (p.b !== null) {
          right.push({ num: p.b + 1, text: newLines[p.b], kind: p.kind === 'same' ? 'same' : p.kind === 'mod' ? 'mod' : 'add', sign: p.kind === 'same' ? '' : '+' });
        }
      }
      return { left, right, adds, dels };
    }

    function relPath(path, cwd) {
      if (!cwd || !path) return path;
      const c = String(cwd).replace(/\\/g, '/');
      const p = String(path).replace(/\\/g, '/');
      if (p === c) return path;
      if (p.indexOf(c + '/') === 0) return p.slice(c.length + 1);
      return path;
    }

    // —— React 渲染 ——
    function CodePanel(props) {
      const { title, isNew, rows, group, empty, offset } = props;
      const children = [];
      if (rows.length) {
        for (const r of rows) {
          const toks = tokenizeLine(r.text, group);
          children.push(React.createElement('div', { className: 'cdv-line cdv-' + r.kind, key: r.num },
            React.createElement('span', { className: 'cdv-gutter' },
              React.createElement('span', { className: 'cdv-sign' }, r.sign),
              React.createElement('span', { className: 'cdv-num' }, r.num + (offset || 0))
            ),
            React.createElement('span', { className: 'cdv-codetext' },
              toks.map((t, i) => React.createElement('span', { className: 'cdv-tok cdv-tok-' + t.cls, key: i }, t.text))
            )
          ));
        }
      } else {
        children.push(React.createElement('div', { className: 'cdv-empty', key: 'e' }, empty));
      }
      return React.createElement('div', { className: 'cdv-col' + (isNew ? ' cdv-col-new' : '') },
        React.createElement('div', { className: 'cdv-col-head' }, title),
        React.createElement('div', { className: 'cdv-codes' }, children)
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
        const rows = hunkRows(h);
        adds += rows.adds;
        dels += rows.dels;
        hunks.push({ path: h.path, group: groupOf(h.path), left: rows.left, right: rows.right, adds: rows.adds, dels: rows.dels, newText: h.newText });
      }

      // —— 绝对行号定位：settled 后向 Host 反推每个 hunk 的起始行 ——
      const [locStarts, setLocStarts] = React.useState(null);
      const sig = model.state === 'done' && hunks.length ? hunks.map((h) => h.path + '\u0000' + h.newText).join('|') : '';
      React.useEffect(() => {
        if (!sig) {
          setLocStarts(null);
          return;
        }
        let alive = true;
        Promise.all(hunks.map((h, i) => locateHunk(h.path, h.newText).then((s) => [i, s]))).then((res) => {
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
              const offset = locStarts && typeof locStarts[i] === 'number' ? locStarts[i] - 1 : 0;
              const both = h.adds > 0 && h.dels > 0;
              let cols = null;
              if (both) {
                cols = [
                  React.createElement(CodePanel, { key: 'a', title: '修改前', isNew: false, rows: h.left, group: h.group, empty: '（无内容）', offset }),
                  React.createElement(CodePanel, { key: 'b', title: '修改后', isNew: true, rows: h.right, group: h.group, empty: '（无内容）', offset })
                ];
              } else if (h.adds > 0) {
                cols = React.createElement(CodePanel, { title: '新增', isNew: true, rows: h.right, group: h.group, empty: '（无内容）', offset });
              } else if (h.dels > 0) {
                cols = React.createElement(CodePanel, { title: '删除', isNew: false, rows: h.left, group: h.group, empty: '（无内容）', offset });
              } else {
                cols = React.createElement(CodePanel, { title: '修改前', isNew: false, rows: h.left, group: h.group, empty: '（无实际变更）', offset });
              }
              return React.createElement('div', { className: 'cdv-hunk', key: i },
                React.createElement('div', { className: 'cdv-hunk-path' },
                  hunks.length > 1 ? h.path + ' · 第 ' + (i + 1) + ' 处变更' : relPath(h.path, cwd)
                ),
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
      const titleText = toolName === 'write' ? 'Write' : 'Edit';

      return React.createElement('div', { className: 'cdv-card' + (model.state === 'error' ? ' cdv-err' : '') },
        React.createElement('div', { className: 'cdv-head', onClick: function () { setOpen(!open); } },
          React.createElement('span', { className: 'cdv-chev' + (open ? ' cdv-open' : '') }, '▸'),
          React.createElement('span', { className: 'cdv-title' }, titleText),
          path ? React.createElement('span', { className: 'cdv-path', onClick: function (e) { e.stopPropagation(); if (typeof openFile === 'function') openFile(path); } }, relPath(path, cwd)) : null,
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
.cdv-head { display: flex; align-items: center; gap: 7px; padding: 7px 12px; cursor: pointer; user-select: none; color: inherit; font: inherit; }
.cdv-chev { display: inline-block; transition: transform .15s ease; color: rgba(128,128,128,.95); font-size: 10px; }
.cdv-chev.cdv-open { transform: rotate(90deg); }
.cdv-title { font-weight: 600; font-size: 13px; }
.cdv-path { color: #58a6ff; margin-left: 4px; font-weight: 400; }
.cdv-path:hover { text-decoration: underline; }
.cdv-badge { margin-left: auto; display: flex; gap: 6px; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: rgba(128,128,128,.12); padding: 1px 8px; border-radius: 99px; }
.cdv-badd { color: #7ee787; }
.cdv-bdel { color: #ff7b72; }
.cdv-state { font-size: 11px; color: rgba(128,128,128,.9); }
.cdv-card.cdv-err .cdv-head { color: #ff7b72; }
.cdv-body { border-top: 1px solid rgba(128,128,128,.16); }
.cdv-hunk + .cdv-hunk { border-top: 1px dashed rgba(128,128,128,.28); }
.cdv-hunk-path { font-size: 11px; color: rgba(128,128,128,.85); padding: 6px 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.cdv-cols { display: flex; align-items: stretch; }
.cdv-col { flex: 1 1 50%; min-width: 0; }
.cdv-col + .cdv-col { border-left: 1px solid rgba(128,128,128,.22); }
.cdv-col-head { padding: 4px 10px; font-size: 11px; color: rgba(128,128,128,.85); background: rgba(128,128,128,.08); }
.cdv-codes { overflow: auto; max-height: 340px; background: #0d1117; font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace; font-size: 12px; line-height: 1.55; color: #d4d4d4; }
.cdv-line { display: flex; white-space: pre; min-width: max-content; }
.cdv-gutter { flex: none; width: 4em; text-align: right; padding-right: .7em; color: rgba(255,255,255,.35); user-select: none; }
.cdv-sign { display: inline-block; width: 1.1em; text-align: center; }
.cdv-line.cdv-mod, .cdv-line.cdv-del { background: rgba(248,81,73,.17); }
.cdv-line.cdv-mod .cdv-sign, .cdv-line.cdv-del .cdv-sign { color: #ff7b72; }
.cdv-col-new .cdv-line.cdv-mod, .cdv-line.cdv-add { background: rgba(63,185,80,.17); }
.cdv-col-new .cdv-line.cdv-mod .cdv-sign, .cdv-line.cdv-add .cdv-sign { color: #7ee787; }
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
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
