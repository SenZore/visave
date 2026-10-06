"use strict";
let groups = [], matches = [], shown = 0;
const search = document.getElementById("site-search"), list = document.getElementById("site-results"), count = document.getElementById("site-count"), more = document.getElementById("more-sites");
function render(reset = true) {
  if (reset) { list.replaceChildren(); shown = 0; const query = search.value.trim().toLocaleLowerCase(); matches = groups.filter(group => group.names.some(name => name.toLocaleLowerCase().includes(query))); }
  const end = Math.min(shown + 60, matches.length);
  for (; shown < end; shown++) {
    const group = matches[shown], item = document.createElement("li"), name = document.createElement("strong"), note = document.createElement("span");
    name.textContent = group.name;
    note.textContent = ` ${group.names.length} extractor${group.names.length === 1 ? "" : "s"}${group.broken ? " · upstream reports broken entries" : ""}`;
    item.append(name, note); list.append(item);
  }
  count.textContent = matches.length ? `${matches.length} groups found · showing ${shown}` : "No matching extractor. A direct video file might still work.";
  more.hidden = shown >= matches.length;
}
search.addEventListener("input", () => render());
more.addEventListener("click", () => render(false));
fetch("sites-data.json").then(response => { if (!response.ok) throw new Error("List unavailable"); return response.json(); }).then(data => {
  groups = data.groups;
  document.getElementById("site-source").textContent = `Imported ${data.imported} · ${data.extractors} upstream extractors · snapshot ${data.commit.slice(0, 12)}. The installed yt-dlp version may have a different list.`;
  render();
}).catch(() => { count.textContent = "The bundled list could not load. Use the upstream list below."; });
