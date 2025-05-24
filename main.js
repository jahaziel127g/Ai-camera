class Dashboard {
  constructor(config) {
    Object.assign(this, config);

    // Elements
    this.video        = document.getElementById(this.videoId);
    this.canvas       = document.getElementById(this.canvasId);
    this.ctx          = this.canvas.getContext('2d');
    this.totalEl      = document.getElementById(this.totalId);
    this.lastEl       = document.getElementById(this.lastId);
    this.typesEl      = document.getElementById(this.typesId);
    this.logEl        = document.getElementById(this.logId);
    this.loader       = document.getElementById('model-loading');
    this.progress     = document.getElementById('model-progress');
    this.errorEl      = document.getElementById('model-error');
    this.errorMsg     = document.getElementById('error-message');
    this.thresholdInput  = document.getElementById(this.thresholdId);
    this.thresholdVal    = document.getElementById(this.thresholdValId);
    this.pauseBtn        = document.getElementById(this.btnPauseId);
    this.resetBtn        = document.getElementById(this.btnResetId);
    this.downloadBtn     = document.getElementById(this.btnDownloadId);

    // Config
    this.trashTypes       = this.trashTypes || ['bottle','cup','bowl'];
    this.counts           = {};
    this.lastLogged       = {};
    this.totalCount       = 0;
    this.running          = true;
    this.threshold        = this.thresholdInput.value / 100;
    this.cameraFacingMode = 'environment';

    // True “input” for detectLoop
    this.inputSource = this.video;

    // Init
    this._loadState();
    this._bindControls();
    this._initTypeList();
  }

  async loadModel() {
    try {
      this._showLoader('Loading model…');
      await tf.ready();
      this.model = await cocoSsd.load();
      return true;
    } catch (err) {
      this._showError(err.message);
      return false;
    }
  }

  async setupCamera() {
    try {
      this._showLoader('Accessing camera…');
      // Stop & clear any ESP32 stream
      const espImg = document.getElementById('esp32-frame');
      espImg.src = '';
      this.inputSource = this.video;

      // Get device camera
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.cameraFacingMode }
      });
      this.video.srcObject = stream;
      await new Promise(r => this.video.onloadedmetadata = r);
      this.video.play();
    } catch (err) {
      this._showError(err.message);
      return false;
    } finally {
      this._hideLoader();
    }

    // Mirror container if front camera
    const container = document.getElementById('video-container');
    if (this.cameraFacingMode === 'user') {
      container.classList.add('scale-x-[-1]');
    } else {
      container.classList.remove('scale-x-[-1]');
    }

    return true;
  }

  async setupESP32Stream(url) {
    this._showLoader('Connecting to ESP32…');
    return new Promise((resolve, reject) => {
      const img = document.getElementById('esp32-frame');
      img.src = url;
      img.onload = () => {
        // switch input to ESP32 img
        this.inputSource = img;
        // remove any mirror
        document.getElementById('video-container').classList.remove('scale-x-[-1]');
        // size canvas
        this.canvas.width  = img.width;
        this.canvas.height = img.height;
        this._hideLoader();
        resolve(true);
      };
      img.onerror = () => {
        this._showError('ESP32 stream failed');
        reject();
      };
    });
  }

  async detectLoop() {
    if (!this.model || !this.running) {
      requestAnimationFrame(() => this.detectLoop());
      return;
    }

    const inp = this.inputSource;
    this.canvas.width  = inp.videoWidth || inp.width;
    this.canvas.height = inp.videoHeight || inp.height;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(inp, 0, 0, this.canvas.width, this.canvas.height);

    try {
      const preds = await this.model.detect(inp);
      for (const p of preds) {
        if (this.trashTypes.includes(p.class) && p.score > this.threshold) {
          const [x, y, w, h] = p.bbox;
          const score = Math.round(p.score * 100);
          this.ctx.strokeStyle = 'lime';
          this.ctx.lineWidth   = 2;
          this.ctx.strokeRect(x, y, w, h);
          this.ctx.fillStyle   = 'lime';
          this.ctx.font        = '16px sans-serif';
          this.ctx.fillText(`${p.class} ${score}%`, x, y - 6);
          this._logDetection(p.class, score);
        }
      }
    } catch (e) {
      console.error('Detect error:', e);
    }

    requestAnimationFrame(() => this.detectLoop());
  }

  _logDetection(type, score) {
    const now = Date.now();
    if (now - (this.lastLogged[type] || 0) < 2000) return;
    this.lastLogged[type] = now;

    this.totalCount++;
    this.totalEl.textContent = this.totalCount;

    const t = new Date().toLocaleTimeString();
    this.lastEl.textContent = `${type} ${score}% at ${t}`;

    const li = document.createElement('li');
    li.textContent = `[${t}] Detected ${type} (${score}%)`;
    this.logEl.prepend(li);

    this.counts[type] = (this.counts[type] || 0) + 1;
    document.getElementById(`count-${type}`).textContent = `${type}: ${this.counts[type]}`;

    this._saveState();
  }

  _downloadCSV() {
    const rows = [['Time','Event']];
    Array.from(this.logEl.children).reverse().forEach(li => {
      const m = li.textContent.match(/^\[(.+?)\]\s(.+)$/);
      if (m) rows.push([m[1], m[2]]);
    });
    const csv = rows.map(r => r.map(f=>`"${f}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'detections.csv';
    a.click();
  }

  _bindControls() {
    this.thresholdInput.oninput = e => {
      this.threshold = e.target.value / 100;
      this.thresholdVal.textContent = `${e.target.value}%`;
    };
    this.pauseBtn.onclick = () => {
      this.running = !this.running;
      this.pauseBtn.textContent = this.running ? 'Pause' : 'Resume';
    };
    this.resetBtn.onclick    = () => location.reload();
    this.downloadBtn.onclick = () => this._downloadCSV();

    document.getElementById('btn-switch-camera').onclick = async () => {
      this.cameraFacingMode = this.cameraFacingMode === 'environment' ? 'user' : 'environment';
      if (this.video.srcObject) {
        this.video.srcObject.getTracks().forEach(t => t.stop());
      }
      await this.setupCamera();
    };
  }

  _initTypeList() {
    this.typesEl.innerHTML = '';
    for (const t of this.trashTypes) {
      this.counts[t] = this.counts[t] || 0;
      const li = document.createElement('li');
      li.id = `count-${t}`;
      li.textContent = `${t}: ${this.counts[t]}`;
      this.typesEl.append(li);
    }
    this.totalEl.textContent = this.totalCount;
  }

  _loadState() {
    const s = JSON.parse(localStorage.getItem('dashState')||'{}');
    if (s.counts)     this.counts     = s.counts;
    if (s.total)      this.totalCount = s.total;
    if (s.threshold!=null) {
      this.threshold = s.threshold;
      this.thresholdInput.value = Math.round(this.threshold*100);
      this.thresholdVal.textContent = `${Math.round(this.threshold*100)}%`;
    }
  }

  _saveState() {
    localStorage.setItem('dashState',
      JSON.stringify({ counts:this.counts, total:this.totalCount, threshold:this.threshold })
    );
  }

  _showLoader(msg='') {
    this.progress.textContent = msg;
    this.loader.classList.remove('hidden');
  }
  _hideLoader() {
    this.loader.classList.add('hidden');
  }
  _showError(msg) {
    this.errorMsg.innerHTML = msg.replace(/\n/g,'<br>');
    this.errorEl.classList.remove('hidden');
    this._hideLoader();
  }
}

// ── Bootstrap ──
(async()=>{
  const dash = new Dashboard({
    videoId:'video', canvasId:'canvas',
    totalId:'total', lastId:'last',
    typesId:'types', logId:'log',
    thresholdId:'threshold', thresholdValId:'threshold-val',
    btnPauseId:'btn-pause', btnResetId:'btn-reset', btnDownloadId:'btn-download'
  });

  if (!(await dash.loadModel())) return;

  // show camera enable
  document.getElementById('camera-activation').classList.remove('hidden');
  document.getElementById('btn-enable-camera').onclick = async()=>{
    if (await dash.setupCamera()) {
      document.getElementById('camera-activation').remove();
      dash.detectLoop();
    }
  };

  // ESP32 hook
  document.getElementById('btn-use-esp32').onclick = async()=>{
    const url = document.getElementById('esp32-url').value.trim();
    if (!url) return alert('Enter a valid ESP32‑CAM URL.');
    if (await dash.setupESP32Stream(url)) dash.detectLoop();
  };
})();