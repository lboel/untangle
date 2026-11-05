/* global document */

const pageDocument = document;
const root = pageDocument.documentElement;
const tabs = Array.from(pageDocument.querySelectorAll("[data-journey-tab]"));
const announcement = pageDocument.getElementById("journey-announcement");

root.classList.remove("no-js");
root.classList.add("js");

function selectJourney(selectedTab, options = {}) {
  const { announce = true, moveFocus = true } = options;

  for (const tab of tabs) {
    const selected = tab === selectedTab;
    const controlledPanel = pageDocument.getElementById(tab.getAttribute("aria-controls"));

    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;

    if (controlledPanel) {
      controlledPanel.hidden = !selected;
      controlledPanel.classList.toggle("is-entering", selected && announce);
    }
  }

  if (moveFocus) {
    selectedTab.focus();
  }

  if (announce && announcement) {
    announcement.textContent = `${selectedTab.textContent.trim()} selected.`;
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    selectJourney(tab);
  });

  tab.addEventListener("keydown", (event) => {
    const currentIndex = tabs.indexOf(tab);
    let nextIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    selectJourney(tabs[nextIndex]);
  });
}

const initialTab = tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0];
if (initialTab) {
  selectJourney(initialTab, { announce: false, moveFocus: false });
}

const clipboard = globalThis.navigator?.clipboard;
const copyAnnouncement = pageDocument.getElementById("copy-announcement");
const copyButtons = Array.from(pageDocument.querySelectorAll("[data-copy-command]"));

for (const button of copyButtons) {
  const command = pageDocument.getElementById(button.getAttribute("data-copy-command"));
  if (!command || typeof clipboard?.writeText !== "function") {
    continue;
  }

  button.hidden = false;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Copying…";

    try {
      await clipboard.writeText(command.textContent.trim());
      button.textContent = "Copy again";
      if (copyAnnouncement) {
        copyAnnouncement.textContent =
          "Commands copied. Paste them in a terminal in the Untangle checkout.";
      }
    } catch {
      button.textContent = "Try copy again";
      if (copyAnnouncement) {
        copyAnnouncement.textContent =
          "Clipboard access was blocked. Select and copy the commands above.";
      }
    } finally {
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
    }
  });
}
