const site = window.TECHORDIA_SITE;

const serviceGrid = document.querySelector("[data-services]");
if (serviceGrid) {
  serviceGrid.innerHTML = site.services
    .map(
      (service, index) => `
        <article class="service-card" style="--delay: ${index * 70}ms">
          <span>${String(index + 1).padStart(2, "0")}</span>
          <h3>${service.title}</h3>
          <p>${service.body}</p>
        </article>
      `,
    )
    .join("");
}

const process = document.querySelector("[data-process]");
if (process) {
  process.innerHTML = site.process
    .map(
      (step, index) => `
        <article>
          <span>${String(index + 1).padStart(2, "0")}</span>
          <p>${step}</p>
        </article>
      `,
    )
    .join("");
}

const revealTargets = document.querySelectorAll(".service-card, .process article, .resilience-list article");
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    });
  },
  { threshold: 0.18 },
);

revealTargets.forEach((target) => observer.observe(target));

const header = document.querySelector("[data-header]");
window.addEventListener("scroll", () => {
  header.toggleAttribute("data-scrolled", window.scrollY > 16);
});
