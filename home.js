const top = document.querySelector(".site-top");
const year = document.querySelector("#year");

if (year) year.textContent = String(new Date().getFullYear());

const onScroll = () => {
  if (!top) return;
  top.classList.toggle("is-scrolled", window.scrollY > 8);
};

onScroll();
window.addEventListener("scroll", onScroll, { passive: true });
