import React, { useEffect, useMemo, useRef, useState } from "react";

// =========================================
// Circuit Word Puzzle — Google Sheets + 10 Random Words + Logic Gate Viz
// - "게임 시작(10문제)" 클릭 시: 구글시트 로드 → 10문제 랜덤 세트 → 즉시 시작
// - 구글시트 A열 2행부터 단어 로드 (링크 공개 필요)
// - 각 문제: 영어 정의(영문 설명) 힌트 표시 (dictionaryapi.dev → 실패 시 대체 힌트)
// - 오답 시: 현재 단어는 포기 → 다른 단어를 즉시 랜덤 출제, 오답 목록에 기록
// - 종료 시: 팝업에 오답 목록(Your Answer → Correct) 표시
// =========================================

export default function App() {
  const [wordsLoaded, setWordsLoaded] = useState(false);
  const [starting, setStarting] = useState(false); // 시작 중 상태(중복 클릭 방지)
  const [sheetUrl, setSheetUrl] = useState(
    "https://docs.google.com/spreadsheets/d/1KlBwvsZatKpCwgmMHkRbOIHg6YccLIyr55nKtqkND-4"
  );

  const [allWords, setAllWords] = useState([]);      // 전체 단어 (대문자)
  const [remaining, setRemaining] = useState([]);    // 출제 풀(남은 문제)
  const [current, setCurrent] = useState(null);      // 현재 정답 단어 (대문자)

  const [definition, setDefinition] = useState("");  // 힌트(영문 정의)
  const [letters, setLetters] = useState([]);        // 팔레트(드래그 가능한 부품)
  const [slots, setSlots] = useState([]);            // 슬롯(배치된 글자)

  const [correctCount, setCorrectCount] = useState(0); // 맞힌 개수 (10개 달성 시 종료)
  const [wrongList, setWrongList] = useState([]);      // {yourAnswer, correct}

  const [ledOn, setLedOn] = useState(false);
  const [flow, setFlow] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [shake, setShake] = useState(false);

  const audioCtxRef = useRef(null);

  useEffect(() => {
    audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
  }, []);

  // ===== 구글시트(A2:A) 로드 =====
  const parseSheetUrl = (url) => {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\/d\/([a-zA-Z0-9-_]+)/);
      const id = m?.[1];
      const gidMatch = u.hash.match(/gid=(\d+)/);
      const gid = gidMatch ? gidMatch[1] : "0";
      return { id, gid };
    } catch {
      return { id: null, gid: "0" };
    }
  };

  const buildGvizUrl = (id, gid) =>
    `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:json&range=A2:A&gid=${gid}`;

  // 단어 배열을 반환하도록 구현 (버튼 1번으로 로드→시작)
  const loadFromGoogleSheet = async () => {
    const { id, gid } = parseSheetUrl(sheetUrl);
    if (!id) {
      alert("유효한 구글시트 URL이 아닙니다.");
      return [];
    }
    try {
      const res = await fetch(buildGvizUrl(id, gid));
      if (!res.ok) throw new Error("fetch failed");
      const text = await res.text();
      const jsonStr = text.replace(/^[^{]+/, "").replace(/[^}]+$/, ""); // gviz 래핑 제거
      const data = JSON.parse(jsonStr);
      const rows = data?.table?.rows || [];

      let words = rows
        .map((r) => r?.c?.[0]?.v ?? "")
        .map((v) => String(v).trim())
        .filter(Boolean)
        .map((w) => w.replace(/[^A-Za-z]/g, "")) // 알파벳만
        .filter((w) => w.length >= 3)            // 최소 3글자
        .map((w) => w.toUpperCase());

      words = Array.from(new Set(words));
      if (words.length === 0) {
        alert("구글시트에서 단어를 찾지 못했습니다. A열 2행부터 영단어가 있는지 확인해주세요.");
        return [];
      }
      setAllWords(words);
      setRemaining(words);
      setWordsLoaded(true);
      return words; // ✅ 반환
    } catch (e) {
      console.error(e);
      alert("구글시트 로딩에 실패했습니다. 공유 권한(링크가 있는 모든 사용자 보기) 또는 URL을 확인해주세요.");
      return [];
    }
  };

  // ===== 게임 시작(10문제 세트 고정) =====
  const startGame = async (sourceWords = allWords) => {
    try { await audioCtxRef.current?.resume?.(); } catch {}

    setCorrectCount(0);
    setWrongList([]);
    setShowResult(false);
    setLedOn(false);
    setFlow(false);

    const set10 = shuffle(sourceWords).slice(0, Math.min(10, sourceWords.length));
    if (set10.length === 0) return;
    setRemaining(set10);
    pickNext(set10);
  };

  // 시작 버튼 래퍼: 시트 로드 → 즉시 시작
  const startCombined = async () => {
    if (starting) return;
    setStarting(true);
    try {
      let words = allWords;
      if (!wordsLoaded || allWords.length === 0) {
        words = await loadFromGoogleSheet();
      }
      if (words && words.length > 0) {
        await startGame(words);
      }
    } finally {
      setStarting(false);
    }
  };

  // ===== 다음 문제 선택 =====
  const pickNext = async (pool) => {
    const list = pool ?? remaining;
    if (!list || list.length === 0) {
      return; // 세트 종료(LED/모달은 정답 처리 시점에서 제어)
    }
    const word = list[0];
    const rest = list.slice(1);
    setRemaining(rest);
    setCurrent(word);
    setSlots(Array(word.length).fill(null));
    setLetters(buildPalette(word));

    const def = await fetchDefinition(word);
    setDefinition(def || hintFallback(word));
  };

  // ===== 영어 정의 가져오기 (dictionaryapi.dev) =====
  const fetchDefinition = async (word) => {
    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
      if (!res.ok) return "";
      const data = await res.json();
      const first = data?.[0];
      const meaningBlocks = first?.meanings || [];
      for (const m of meaningBlocks) {
        const defs = m.definitions || [];
        if (defs.length > 0 && defs[0].definition) {
          return defs[0].definition;
        }
      }
      return first?.word ? `A word related to: ${first.word}` : "";
    } catch {
      return "";
    }
  };

  // ===== 정의 없을 때 대체 힌트 =====
  const hintFallback = (word) => {
    const first = word[0];
    const last = word[word.length - 1];
    return `An English word of length ${word.length}, starting with '${first}' and ending with '${last}'.`;
  };

  // ===== 팔레트(정답 문자 + 미끼 문자) =====
  const buildPalette = (word) => {
    const chars = word.split("");
    const decoyCount = Math.min(5, Math.max(3, 10 - chars.length)); // 길이에 따라 3~5개
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const notIn = alphabet.filter((c) => !chars.includes(c));
    const decoys = sample(notIn, decoyCount);
    return shuffle([...chars, ...decoys]);
  };

  // ===== 드래그 앤 드롭 =====
  const onDragStart = (e, letter) => {
    e.dataTransfer.setData("text/plain", letter);
  };
  const onDropToSlot = (e, idx) => {
    e.preventDefault();
    const letter = e.dataTransfer.getData("text/plain");
    if (!letter) return;

    let removed = false;
    const newPalette = letters.filter((p) => {
      if (!removed && p === letter) {
        removed = true;
        return false;
      }
      return true;
    });

    const newSlots = [...slots];
    newSlots[idx] = letter;

    setSlots(newSlots);
    setLetters(newPalette);

    if (newSlots.every((s) => s !== null)) {
      const attempt = newSlots.join("");
      if (attempt === current) {
        // 정답
        playTone("success");
        setFlow(true);
        setTimeout(() => setFlow(false), 1000);
        const nextCount = correctCount + 1;
        setCorrectCount(nextCount);
        if (nextCount >= 10) {
          setLedOn(true);
          setTimeout(() => setShowResult(true), 400);
        } else {
          pickNext();
        }
      } else {
        // 오답 → 기록 후 즉시 새 단어로 교체
        playTone("error");
        setShake(true);
        setWrongList((prev) => [...prev, { yourAnswer: attempt, correct: current }]);
        setTimeout(() => setShake(false), 500);
        pickNext();
      }
    }
  };
  const onDragOver = (e) => e.preventDefault();

  // ===== 사운드 =====
  const playTone = (kind) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (kind === "success") {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 440;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      o.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.18);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o.start(); o.stop(ctx.currentTime + 0.55);
    } else {
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const g = ctx.createGain();
      o1.type = "square"; o2.type = "sawtooth";
      o1.frequency.value = 220; o2.frequency.value = 160;
      o1.connect(g); o2.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
      o1.start(); o2.start(); o1.stop(ctx.currentTime + 0.5); o2.stop(ctx.currentTime + 0.5);
    }
  };

  // ===== 유틸 =====
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function sample(arr, n) {
    return shuffle(arr).slice(0, n);
  }

  // ===== UI =====
  return (
    <div style={sx.app}>
      <h1 style={sx.title}>😊Circuit Word Puzzle📱</h1>

      {/* 시작(구글시트 자동 로드) */}
      <div style={sx.toolbar}>
        <input
          type="url"
          value={sheetUrl}
          onChange={(e) => setSheetUrl(e.target.value)}
          placeholder="구글시트 URL (A열 2행부터)"
          style={{
            flex: 1,
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid #cfe8d8",
            outline: "none",
          }}
        />
        <button style={sx.btn} onClick={startCombined} disabled={starting}>
          {starting ? "불러오는 중..." : "게임 시작 (10문제)"}
        </button>
        <span style={{ marginLeft: 12, color: wordsLoaded ? "#0b8457" : "#999" }}>
          {wordsLoaded ? `단어장에서 ${allWords.length}개 영어단어 로드됨` : "버튼 클릭 시 단어장 로드"}
        </span>
      </div>

      {/* 논리 게이트 진행(10개) */}
      <GateProgress count={correctCount} />

      {/* 메인: 힌트 + 회로 */}
      {current && (
        <div style={sx.gameRow}>
          <div style={sx.clueBox}>
            <div style={{ fontSize: 13, color: "#678" }}>Definition (English)</div>
            <div style={{ marginTop: 8, lineHeight: 1.5 }}>{definition}</div>
          </div>
          <div style={sx.circuitArea}>
            <CircuitSVG ledOn={ledOn} flow={flow} />
          </div>
        </div>
      )}

      {/* 슬롯 */}
      {current && (
        <div style={sx.slotsRow}>
          {slots.map((s, i) => (
            <div
              key={i}
              onDragOver={onDragOver}
              onDrop={(e) => onDropToSlot(e, i)}
              style={{ ...sx.slot, ...(shake ? sx.slotWrong : {}) }}
            >
              {s ? <PartIcon letter={s} /> : <div style={sx.placeholder}>Drop</div>}
            </div>
          ))}
        </div>
      )}

      {/* 팔레트 */}
      {current && (
        <div style={sx.paletteRow}>
          {letters.map((p, i) => (
            <div
              key={`${p}-${i}`}
              draggable
              onDragStart={(e) => onDragStart(e, p)}
              style={sx.paletteItem}
              title={`Component: ${p}`}
            >
              <PartIcon letter={p} />
            </div>
          ))}
        </div>
      )}

      {/* 결과 팝업 */}
      {showResult && <ResultModal wrongList={wrongList} onClose={() => setShowResult(false)} />}

      <div style={{ marginTop: 12, color: "#667" }}>
        <small>단어장 A열(2행부터)에서 영어단어를 읽습니다. 문제는 공개 사전 API에서 불러옵니다.</small>
      </div>
    </div>
  );
}

// ---------- 전자부품 아이콘(간단한 칩 모양) ----------
function PartIcon({ letter }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width="64" height="40" viewBox="0 0 64 40">
        <rect x="0" y="0" width="64" height="40" rx="6" fill="#0b3d2e" />
        <rect x="8" y="8" width="48" height="24" rx="4" fill="#d9e4c8" />
        <rect x="2" y="12" width="4" height="2" fill="#6b6b6b" />
        <rect x="2" y="26" width="4" height="2" fill="#6b6b6b" />
        <rect x="58" y="12" width="4" height="2" fill="#6b6b6b" />
        <rect x="58" y="26" width="4" height="2" fill="#6b6b6b" />
      </svg>
      <div style={{ marginTop: -32, fontWeight: 700, color: "#123" }}>{letter}</div>
    </div>
  );
}

// ---------- 회로 + LED ----------
function CircuitSVG({ ledOn, flow }) {
  return (
    <div style={{ width: 420 }}>
      <svg width="420" height="160" viewBox="0 0 420 160">
        <rect x="0" y="0" width="420" height="160" fill="#f6fbf8" rx="10" />
        <path
          d="M20 80 C 90 10, 160 10, 230 80 S 330 150, 400 80"
          stroke={ledOn ? "#f5d76e" : "#7a7a7a"}
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
        />
        {/* 흐름 점 */}
        <circle r="6" fill="#ffd54a" style={{ visibility: flow ? "visible" : "hidden" }}>
          <animateMotion
            path="M20 80 C 90 10, 160 10, 230 80 S 330 150, 400 80"
            dur="1s"
            repeatCount="1"
          />
        </circle>
        {/* LED */}
        <g transform="translate(400,76)">
          <circle cx="0" cy="0" r="10" fill={ledOn ? "#fff59d" : "#222"} />
          {ledOn && (
            <circle cx="0" cy="0" r="18" fill="none" stroke="#ffec8b" strokeWidth="2">
              <animate attributeName="opacity" values="0;1;0" dur="1s" repeatCount="indefinite" />
            </circle>
          )}
        </g>
      </svg>
    </div>
  );
}

// ---------- 논리 게이트 진행(10개) ----------
function GateProgress({ count }) {
  const gates = useMemo(
    () => ["AND", "OR", "XOR", "NAND", "NOR", "XNOR", "NOT", "BUF", "AND", "OR"],
    []
  );
  return (
    <div style={sx.gateRow}>
      {gates.map((g, i) => (
        <div
          key={i}
          style={{
            ...sx.gateBox,
            borderColor: i < count ? "#0b8457" : "#d6e2da",
            background: i < count ? "#e8fff4" : "#fff",
          }}
        >
          <GateIcon type={g} active={i < count} />
        </div>
      ))}
    </div>
  );
}

function GateIcon({ type, active }) {
  const stroke = active ? "#0b8457" : "#98a6a0";
  const fill = active ? "#b9f5d6" : "#e9efec";
  return (
    <svg width="60" height="36" viewBox="0 0 60 36">
      {type === "AND" && (
        <g>
          <rect x="5" y="6" width="30" height="24" rx="4" fill={fill} stroke={stroke} />
          <path d="M35 6 A12 12 0 0 1 35 30" fill={fill} stroke={stroke} />
          <line x1="5" y1="12" x2="0" y2="12" stroke={stroke} />
          <line x1="5" y1="24" x2="0" y2="24" stroke={stroke} />
          <line x1="47" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
      {type === "OR" && (
        <g>
          <path d="M5 6 C15 6,18 12,20 18 C18 24,15 30,5 30" fill={fill} stroke={stroke} />
          <path d="M20 6 C35 12,35 24,20 30" fill={fill} stroke={stroke} />
          <line x1="0" y1="12" x2="12" y2="12" stroke={stroke} />
          <line x1="0" y1="24" x2="12" y2="24" stroke={stroke} />
          <line x1="38" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
      {type === "XOR" && (
        <g>
          <path d="M3 6 C13 6,16 12,18 18 C16 24,13 30,3 30" fill="none" stroke={stroke} />
          <path d="M7 6 C17 6,20 12,22 18 C20 24,17 30,7 30" fill={fill} stroke={stroke} />
          <path d="M22 6 C37 12,37 24,22 30" fill={fill} stroke={stroke} />
          <line x1="0" y1="12" x2="10" y2="12" stroke={stroke} />
          <line x1="0" y1="24" x2="10" y2="24" stroke={stroke} />
          <line x1="40" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
      {type === "NAND" && (
        <g>
          <rect x="5" y="6" width="30" height="24" rx="4" fill={fill} stroke={stroke} />
          <path d="M35 6 A12 12 0 0 1 35 30" fill={fill} stroke={stroke} />
          <circle cx="50" cy="18" r="3" fill="#fff" stroke={stroke} />
          <line x1="5" y1="12" x2="0" y2="12" stroke={stroke} />
          <line x1="5" y1="24" x2="0" y2="24" stroke={stroke} />
          <line x1="53" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
      {type === "NOR" && (
        <g>
          <path d="M5 6 C15 6,18 12,20 18 C18 24,15 30,5 30" fill={fill} stroke={stroke} />
          <path d="M20 6 C35 12,35 24,20 30" fill={fill} stroke={stroke} />
          <circle cx="40" cy="18" r="3" fill="#fff" stroke={stroke} />
          <line x1="0" y1="12" x2="12" y2="12" stroke={stroke} />
          <line x1="0" y1="24" x2="12" y2="24" stroke={stroke} />
          <line x1="43" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
      {type === "XNOR" && (
        <g>
          <path d="M3 6 C13 6,16 12,18 18 C16 24,13 30,3 30" fill="none" stroke={stroke} />
          <path d="M7 6 C17 6,20 12,22 18 C20 24,17 30,7 30" fill={fill} stroke={stroke} />
          <path d="M22 6 C37 12,37 24,22 30" fill={fill} stroke={stroke} />
          <circle cx="42" cy="18" r="3" fill="#fff" stroke={stroke} />
          <line x1="0" y1="12" x2="10" y2="12" stroke={stroke} />
          <line x1="0" y1="24" x2="10" y2="24" stroke={stroke} />
          <line x1="45" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
      {type === "NOT" && (
        <g>
          <path d="M5 6 L35 18 L5 30 Z" fill={fill} stroke={stroke} />
          <circle cx="40" cy="18" r="3" fill="#fff" stroke={stroke} />
          <line x1="0" y1="18" x2="5" y2="18" stroke={stroke} />
          <line x1="43" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
      {type === "BUF" && (
        <g>
          <path d="M5 6 L35 18 L5 30 Z" fill={fill} stroke={stroke} />
          <line x1="0" y1="18" x2="5" y2="18" stroke={stroke} />
          <line x1="35" y1="18" x2="60" y2="18" stroke={stroke} />
        </g>
      )}
    </svg>
  );
}

// ---------- 결과 모달 ----------
function ResultModal({ wrongList, onClose }) {
  return (
    <div style={sx.modalBackdrop}>
      <div style={sx.modal}>
        <h3 style={{ marginTop: 0 }}>Incorrect Answers (정답 안내)</h3>
        {wrongList.length === 0 ? (
          <div style={{ color: "#0b8457" }}>완벽합니다! 모든 문제를 한 번에 맞추셨습니다.</div>
        ) : (
          <div style={sx.wrongList}>
            {wrongList.map((w, i) => (
              <div key={i} style={sx.wrongItem}>
                <span style={{ color: "#b23" }}>{w.yourAnswer}</span>
                <span style={{ margin: "0 8px" }}>→</span>
                <span style={{ fontWeight: 600 }}>{w.correct}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ textAlign: "right", marginTop: 16 }}>
          <button onClick={onClose} style={sx.btn}>닫기</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 스타일 ----------
const sx = {
  app: {
    fontFamily: "Inter, Roboto, Arial, sans-serif",
    padding: 20,
    maxWidth: 1000,
    margin: "16px auto",
    background: "#fff",
    borderRadius: 12,
    boxShadow: "0 8px 24px rgba(20,20,20,0.06)",
  },
  title: { margin: 0, marginBottom: 12, fontSize: 20 },
  toolbar: { display: "flex", gap: 10, alignItems: "center", marginBottom: 12 },
  uploadLabel: {
    border: "1px solid #cfe8d8",
    padding: "6px 10px",
    borderRadius: 8,
    background: "#f5fff9",
    cursor: "pointer",
  },
  btn: {
    padding: "6px 12px",
    borderRadius: 8,
    border: "none",
    background: "#0b8457",
    color: "#fff",
    cursor: "pointer",
  },
  gameRow: { display: "flex", gap: 20, alignItems: "stretch" },
  clueBox: {
    flex: 1,
    border: "1px solid #e6f4ea",
    background: "#f7fffb",
    borderRadius: 10,
    padding: 12,
    minHeight: 110,
  },
  circuitArea: { width: 460, display: "flex", alignItems: "center", justifyContent: "center" },
  slotsRow: { display: "flex", gap: 12, marginTop: 16, justifyContent: "center", flexWrap: "wrap" },
  slot: {
    width: 84,
    height: 64,
    borderRadius: 10,
    background: "#fbfffb",
    border: "1px dashed #cfd8ce",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  slotWrong: { border: "2px solid #e74c3c" },
  placeholder: { color: "#9aa39a", fontSize: 12 },
  paletteRow: {
    display: "flex",
    gap: 12,
    marginTop: 18,
    flexWrap: "wrap",
    justifyContent: "center",
  },
  paletteItem: {
    width: 84,
    height: 64,
    borderRadius: 10,
    background: "#fff",
    border: "1px solid #e6e6e6",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "grab",
  },
  gateRow: { display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 8, marginBottom: 12 },
  gateBox: {
    border: "2px solid #d6e2da",
    background: "#fff",
    borderRadius: 10,
    padding: 6,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.28)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modal: { background: "#fff", borderRadius: 12, padding: 16, width: 420, boxShadow: "0 10px 30px rgba(0,0,0,0.2)" },
  wrongList: { maxHeight: 280, overflow: "auto", padding: 8, border: "1px solid #eee", borderRadius: 8, background: "#fcfdfc" },
  wrongItem: { padding: "6px 8px", borderBottom: "1px dashed #e9ece8" },
};
