// Adds a copy button to every command block marked data-copy. Without JavaScript the
// commands are still there to select by hand.
(() => {
  const ko = document.documentElement.lang === "ko";
  const label = ko ? "복사" : "Copy";
  const done = ko ? "복사됨" : "Copied";
  document.querySelectorAll("[data-copy]").forEach((block) => {
    const code = block.querySelector("code");
    if (!code || !navigator.clipboard) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = label;
    button.setAttribute("aria-label", (ko ? "명령 복사: " : "Copy command: ") + code.innerText.split("\n")[0]);
    button.addEventListener("click", () => {
      navigator.clipboard.writeText(code.innerText.replace(/\n$/, "")).then(() => {
        button.textContent = done;
        setTimeout(() => {
          button.textContent = label;
        }, 1600);
      });
    });
    block.appendChild(button);
  });
})();
