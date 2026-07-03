(function () {
  fetch("/api/branding")
    .then((r) => r.json())
    .then((data) => {
      const name = (data && data.appName) || "";
      if (name) {
        document.querySelectorAll(".header-name, .logo-name").forEach((el) => {
          el.textContent = name;
        });
        document.querySelectorAll("img.logo-img-sm, img.logo-img-icon-lg, img.logo-img-icon-sm").forEach((el) => {
          el.alt = name;
        });
        if (document.title.includes(" – ")) {
          document.title = name + " – " + document.title.split(" – ").slice(1).join(" – ");
        } else if (document.title.trim()) {
          document.title = name;
        }
        document.querySelectorAll("[data-app-name]").forEach((el) => {
          el.textContent = el.textContent.replace(/{{appName}}/g, name);
        });
      }

      // Swap every logo <img> to the custom logo when one is uploaded.
      // Cache-busted with a timestamp so stale browser caches see the new image.
      if (data && data.hasCustomLogo) {
        const logoUrl = "/api/branding/logo?t=" + Date.now();
        document.querySelectorAll(
          "img.logo-img-sm, img.logo-img-icon-lg, img.logo-img-icon-sm, img[src='/assets/logo.png'], img[src='/assets/favicon.ico']"
        ).forEach((el) => {
          // Only swap actual logo images, not favicon links
          if (el.tagName === "IMG") {
            el.setAttribute("src", logoUrl);
          }
        });
      }
    })
    .catch(() => {});
})();
