/* Ekran görüntüsü üzerine anotasyon — Fabric.js 5.x
 * Araçlar: Seçim, Kalem, Ok, Dikdörtgen, Daire/Elips, Metin
 * Kısayollar: V P A R C T | Del | Ctrl+Z | Esc
 */
window.AppAnnotate = (() => {
  let fc = null;       // fabric.Canvas instance
  let _tool = 'select';
  let _color = '#f85149';
  let _width = 3;
  let _drawing = false;
  let _origX = 0, _origY = 0;
  let _activeObj = null;
  let _history = [];
  let _histPtr = -1;
  const MAX_HIST = 30;

  /* ---- open / close ----------------------------------------- */

  function open(dataUrl) {
    const modal = document.getElementById('modal-annotate');
    if (!modal) return;
    modal.classList.remove('hidden');

    if (fc) { try { fc.dispose(); } catch {} fc = null; }
    _history = []; _histPtr = -1;

    // Delay so modal has rendered and clientWidth/Height are valid
    setTimeout(() => _initCanvas(dataUrl), 40);
  }

  function _initCanvas(dataUrl) {
    const area = document.getElementById('annotate-canvas-area');
    if (!area) return;

    const img = new Image();
    img.onload = () => {
      const maxW = area.clientWidth  - 40;
      const maxH = area.clientHeight - 40;
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = Math.round(img.width  * scale);
      const h = Math.round(img.height * scale);

      fc = new fabric.Canvas('annotate-canvas', {
        width: w, height: h,
        selection: true,
        preserveObjectStacking: true,
      });

      fabric.Image.fromURL(dataUrl, fImg => {
        fImg.scaleToWidth(w);
        fImg.set({ selectable: false, evented: false });
        fc.setBackgroundImage(fImg, () => {
          fc.renderAll();
          _snapshot();
        });
      });

      _bindCanvasEvents();
      setTool('select');
    };
    img.src = dataUrl;
  }

  function close() {
    document.getElementById('modal-annotate')?.classList.add('hidden');
    if (fc) { try { fc.dispose(); } catch {} fc = null; }
    _history = []; _histPtr = -1;
  }

  /* ---- history (undo) --------------------------------------- */

  function _snapshot() {
    if (!fc) return;
    const json = JSON.stringify(fc.toJSON());
    _history = _history.slice(0, _histPtr + 1);
    _history.push(json);
    if (_history.length > MAX_HIST) _history.shift();
    _histPtr = _history.length - 1;
  }

  function undo() {
    if (!fc || _histPtr < 1) return;
    _histPtr--;
    fc.loadFromJSON(_history[_histPtr], () => fc.renderAll());
  }

  /* ---- tool selection --------------------------------------- */

  function setTool(tool) {
    _tool = tool;
    document.querySelectorAll('.annotate-tool-btn[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    if (!fc) return;

    // Reset canvas modes
    fc.isDrawingMode = false;
    fc.selection = false;
    fc.defaultCursor = 'crosshair';
    fc.hoverCursor   = 'crosshair';
    fc.off('mouse:down');
    fc.off('mouse:move');
    fc.off('mouse:up');

    if (tool === 'select') {
      fc.selection     = true;
      fc.defaultCursor = 'default';
      fc.hoverCursor   = 'move';
    } else if (tool === 'pen') {
      fc.isDrawingMode = true;
      fc.freeDrawingBrush.color = _color;
      fc.freeDrawingBrush.width = _width;
    } else if (tool === 'text') {
      fc.on('mouse:down', _handleTextDown);
    } else {
      fc.on('mouse:down', _handleShapeDown);
      fc.on('mouse:move', _handleShapeMove);
      fc.on('mouse:up',   _handleShapeUp);
    }
  }

  /* ---- shape drawing handlers ------------------------------- */

  function _handleTextDown(opt) {
    if (opt.target) return;
    const p = fc.getPointer(opt.e);
    const t = new fabric.IText('Metin', {
      left: p.x, top: p.y,
      fontSize: 22,
      fill: _color,
      fontWeight: 'bold',
      fontFamily: 'Inter, sans-serif',
      stroke: null,
    });
    fc.add(t);
    fc.setActiveObject(t);
    t.enterEditing();
    t.selectAll();
  }

  function _handleShapeDown(opt) {
    if (opt.target) return;
    const p = fc.getPointer(opt.e);
    _origX = p.x; _origY = p.y;
    _drawing = true;

    if (_tool === 'rect') {
      _activeObj = new fabric.Rect({
        left: p.x, top: p.y, width: 0, height: 0,
        fill: 'transparent', stroke: _color, strokeWidth: _width,
        selectable: false,
      });
    } else if (_tool === 'circle') {
      _activeObj = new fabric.Ellipse({
        left: p.x, top: p.y, rx: 0, ry: 0,
        fill: 'transparent', stroke: _color, strokeWidth: _width,
        selectable: false,
      });
    } else if (_tool === 'arrow') {
      _activeObj = new fabric.Line([p.x, p.y, p.x, p.y], {
        stroke: _color, strokeWidth: Math.max(2, _width),
        selectable: false,
      });
    }
    if (_activeObj) fc.add(_activeObj);
  }

  function _handleShapeMove(opt) {
    if (!_drawing || !_activeObj) return;
    const p = fc.getPointer(opt.e);

    if (_tool === 'rect') {
      _activeObj.set({
        left:   Math.min(p.x, _origX),
        top:    Math.min(p.y, _origY),
        width:  Math.abs(p.x - _origX),
        height: Math.abs(p.y - _origY),
      });
    } else if (_tool === 'circle') {
      _activeObj.set({
        left: Math.min(p.x, _origX),
        top:  Math.min(p.y, _origY),
        rx:   Math.abs(p.x - _origX) / 2,
        ry:   Math.abs(p.y - _origY) / 2,
      });
    } else if (_tool === 'arrow') {
      _activeObj.set({ x2: p.x, y2: p.y });
    }
    fc.renderAll();
  }

  function _handleShapeUp() {
    if (!_drawing) return;
    _drawing = false;

    if (_activeObj) {
      if (_tool === 'arrow') {
        // Çizgiden gerçek ok yap
        const l = _activeObj;
        fc.remove(l);
        const arrow = _makeArrow(l.x1, l.y1, l.x2, l.y2);
        if (arrow) {
          fc.add(arrow);
          fc.setActiveObject(arrow);
        }
      } else {
        _activeObj.set({ selectable: true });
        fc.setActiveObject(_activeObj);
      }
      _activeObj = null;
    }
    _snapshot();
  }

  function _makeArrow(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 4) return null;

    const angle   = Math.atan2(dy, dx);
    const headLen = Math.min(Math.max(14, _width * 5), len * 0.42);
    const spread  = Math.PI / 7;

    const hx1 = x2 - headLen * Math.cos(angle - spread);
    const hy1 = y2 - headLen * Math.sin(angle - spread);
    const hx2 = x2 - headLen * Math.cos(angle + spread);
    const hy2 = y2 - headLen * Math.sin(angle + spread);

    return new fabric.Path(
      `M ${x1} ${y1} L ${x2} ${y2} M ${hx1} ${hy1} L ${x2} ${y2} L ${hx2} ${hy2}`,
      {
        stroke: _color,
        strokeWidth: Math.max(2, _width),
        fill: '',
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
      }
    );
  }

  /* ---- canvas lifecycle events ------------------------------ */

  function _bindCanvasEvents() {
    fc.on('object:modified',     () => _snapshot());
    fc.on('path:created',        () => _snapshot());
    fc.on('text:editing:exited', () => _snapshot());
  }

  /* ---- color / width ---------------------------------------- */

  function setColor(c) {
    _color = c;
    const preview = document.getElementById('annotate-color-preview');
    if (preview) preview.style.background = c;
    // sync preset buttons
    document.querySelectorAll('.annotate-preset-color').forEach(b => {
      b.classList.toggle('active', b.dataset.color === c);
    });
    if (fc?.isDrawingMode) fc.freeDrawingBrush.color = c;
  }

  function setWidth(w) {
    _width = parseInt(w, 10);
    const lbl = document.getElementById('annotate-width-val');
    if (lbl) lbl.textContent = _width;
    if (fc?.isDrawingMode) fc.freeDrawingBrush.width = _width;
  }

  /* ---- actions ---------------------------------------------- */

  function deleteSelected() {
    if (!fc) return;
    fc.getActiveObjects().forEach(o => fc.remove(o));
    fc.discardActiveObject();
    fc.renderAll();
    _snapshot();
  }

  function clearAnnotations() {
    if (!fc) return;
    const bg = fc.backgroundImage;
    fc.clear();
    if (bg) fc.setBackgroundImage(bg, fc.renderAll.bind(fc));
    else     fc.renderAll();
    _snapshot();
  }

  function download() {
    if (!fc) return;
    const dataUrl = fc.toDataURL({ format: 'png', multiplier: 1 });
    const a = document.createElement('a');
    a.href = dataUrl;
    const now = new Date();
    const ts  = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    a.download = `santiye_not_${ts}.png`;
    a.click();
  }

  /* ---- bind -------------------------------------------------- */

  function bind() {
    document.getElementById('btn-annotate-close')?.addEventListener('click', close);
    document.getElementById('btn-annotate-download')?.addEventListener('click', download);
    document.getElementById('btn-annotate-delete')?.addEventListener('click', deleteSelected);
    document.getElementById('btn-annotate-clear')?.addEventListener('click', clearAnnotations);
    document.getElementById('btn-annotate-undo')?.addEventListener('click', undo);

    document.querySelectorAll('.annotate-tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    // Preset color chips
    document.querySelectorAll('.annotate-preset-color').forEach(btn => {
      btn.addEventListener('click', () => {
        const c = btn.dataset.color;
        document.getElementById('annotate-color').value = c;
        setColor(c);
      });
    });

    document.getElementById('annotate-color')?.addEventListener('input', e => setColor(e.target.value));
    document.getElementById('annotate-width')?.addEventListener('input', e => setWidth(e.target.value));

    // Başlangıç color preview sync
    setColor('#f85149');

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      const modal = document.getElementById('modal-annotate');
      if (modal?.classList.contains('hidden')) return;

      const inEdit = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) ||
                     document.activeElement?.isContentEditable;
      if (!inEdit) {
        const map = { v: 'select', V: 'select', p: 'pen', P: 'pen',
                      a: 'arrow',  A: 'arrow',  r: 'rect', R: 'rect',
                      c: 'circle', C: 'circle', t: 'text', T: 'text' };
        if (map[e.key]) { e.preventDefault(); setTool(map[e.key]); return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
      if (e.key === 'Escape') close();
    });
  }

  return { open, close, bind };
})();
