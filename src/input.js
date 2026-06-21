// 한글 IME 안전 입력 (기획문서 §12 최우선 리스크).
// 숨은 <input>이 조합(composition)을 받고, 조합이 끝나지 않은 Enter는 무시한다.
// - 화면에는 조합 중 글자까지 실시간으로 보여준다(input.value).
// - 엔터(조합 종료 상태)에서만 commit한다.

export class TypingInput {
  constructor(el, onCommit) {
    this.el = el;
    this.onCommit = onCommit;
    this.composing = false;
    this.enabled = false;

    el.addEventListener("compositionstart", () => { this.composing = true; });
    el.addEventListener("compositionend", () => { this.composing = false; });

    el.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      // IME 조합 중 Enter는 글자 확정용 → 시전으로 쓰지 않는다.
      if (e.key === "Enter") {
        if (e.isComposing || this.composing || e.keyCode === 229) return;
        e.preventDefault();
        const text = el.value;
        el.value = "";
        if (text.trim()) this.onCommit(text);
      }
    });
  }

  get current() { return this.el.value; }

  enable() {
    this.enabled = true;
    this.el.value = "";
    this.el.focus();
  }

  disable() {
    this.enabled = false;
    this.el.value = "";
    this.el.blur();
  }

  refocus() { if (this.enabled) this.el.focus(); }
}
