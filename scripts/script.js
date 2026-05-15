const { jsPDF } = window.jspdf;

const actionBtn = document.getElementById("actionBtn");
const messagesContainer = document.getElementById("messagesContainer");

// store information
const state = {
  generationInProgressing: false,
  currentPage: 0,
  maxPage: 0,
  cancelled: false,
  progressInterval: null,
};

// UI functions
function setButtonToGenerationMode(isSuccess) {
  actionBtn.classList.remove("cancel");
  actionBtn.textContent = "Générer le PDF";
  messagesContainer.innerHTML = "";
  if (isSuccess) {
    addMessage("Génération du PDF terminée", "green");
  } else {
    addMessage("Générer le PDF en cliquant sur le bouton ci-dessus");
  }
  actionBtn.onclick = startPdfGeneration
}

function setButtonToCancelMode() {
  actionBtn.classList.add("cancel");
  actionBtn.textContent = "Annuler la génération";
  actionBtn.onclick = cancelPdfGeneration
}

// bootstrap
window.onload = () => {
  if (state.generationInProgressing) {
    setButtonToCancelMode();
    addMessage("Un journal est déjà en cours de création", "green");
    const progressLine = document.createElement("p");
    progressLine.classList.add("green");
    messagesContainer.appendChild(progressLine);
    state.progressInterval = setInterval(function () {
      progressLine.textContent = `pages en cours de génération (${state.currentPage}/${state.maxPage})`;
    }, 500);
    return;
  }
  setButtonToGenerationMode(false);
}

// business logic functions
function cancelPdfGeneration() {
  reset();
  state.cancelled = true;
  setButtonToGenerationMode(false);
}

async function startPdfGeneration() {
  try {
    if (state.generationInProgressing) {
      return;
    }
    state.generationInProgressing = true;
    setButtonToCancelMode();
    let journal = new Journal();
    const html = await getTabHtml();
    messagesContainer.innerHTML = "";
    addMessage("Lancement de la génération du pdf...");
    journal.getJournalKey(html);
    if (!journal.key_find) {
      reset();
      addMessage("Clé de journal pas trouvée...", "red");
      return;
    }

    addMessage(`Clé de journal trouvée: ${journal.journal_key}`, "green");
    journal.getMaterialJSON((error) => {
      reset();
      setButtonToGenerationMode(false);
      if (error.status === 403) {
        addMessage("Erreur obtention material.json: rafraichissez la page (F5)", "red");
      } else {
        addMessage(`Erreur obtention material.json: ${error.status}`, "red");
      }

    }, (material) => {
      console.debug(material);
      addMessage(`Material.json obtenu: journal du ${material.metadata.publication_localized_date}`, "green");
      const progressLine = document.createElement("p");
      progressLine.classList.add("green");
      const pagesLength = material.pages.length;
      messagesContainer.appendChild(progressLine);
      generatePages(journal.journal_key, journal.material, (page) => {
        progressLine.textContent = `Pages en cours de génération (${page}/${pagesLength})`;
        if (page === pagesLength) {
          setButtonToGenerationMode(true);
        }
      })
    });
  } catch (err) {
    reset();
    setButtonToGenerationMode(false);
    addMessage(`Erreur inattendue ${err.message}`, "red");
  }
}

function getTabHtml() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs.length) {
        reject(new Error("Aucun onglet actif"));
        return;
      }
      chrome.scripting.executeScript(
        {
          target: { tabId: tabs[0].id },
          func: () => document.body.innerHTML
        },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!results || !results.length) {
            reject(new Error("Impossible de récupérer le HTML"));
            return;
          }
          resolve(results[0].result);
        }
      );
    });
  });
}

function addMessage(text, classname) {
  const line = document.createElement("p");
  if (classname) {
    line.classList.add(classname);
  }
  line.textContent = text;
  messagesContainer.appendChild(line);
}

async function generatePages(journalKey, material, callbackUpdate) {
  const firstHd = material.pages[0].hd;
  const doc = new jsPDF("p", "px", [firstHd.width, firstHd.height]);

  let pageIndex = 1;
  state.maxPage = material.pages.length;
  for (const page of material.pages) {
    const hd = page.hd;
    state.currentPage = pageIndex;
    callbackUpdate(pageIndex);

    let tileWidth = hd.tile_height; // @TODO : check requested behavior or bug?
    for (let col = 0; col < hd.tile_col_count; col++) {
      if ((col + 1) * hd.tile_width > hd.width) {
        tileWidth = hd.width % hd.tile_width;
      }
      let tileHeight = hd.tile_width; // @TODO : check requested behavior or bug?
      for (let row = 0; row < hd.tile_row_count; row++) {
        if (state.cancelled) {
          reset();
          return;
        }

        if ((row + 1) * hd.tile_height > hd.height) {
          tileHeight = hd.height % hd.tile_height;
        }

        let imgUrl = `${journalKey}/${hd.path}/tile${(col + "").padStart(2, "0")}x${(row + "").padStart(2, "0")}.jpeg`;
        console.debug(imgUrl);
        let image;
        try {
          image = await getDataUri(imgUrl);
        } catch (e) {
          reset();
          addMessage(`Erreur chargement image : ${imgUrl}`, "red");
          return;
        }

        doc.addImage(image, "JPEG", (hd.tile_width * col), (hd.tile_height * row), tileWidth, tileHeight);
        console.debug(`row${row}, col${col}: width${tileWidth}, height:${tileHeight}`);
      }
    }
    }

    pageIndex++;
    if (pageIndex <= material.pages.length) {
      doc.addPage();
    }
  }
  // save
  doc.save(`${material.metadata.provider}_${material.metadata.publication_date}`);
  reset();
}

function getDataUri(url) {
  return new Promise(resolve => {
    const image = new Image();
    image.setAttribute("crossOrigin", "anonymous");

    image.onload = function () {
      const canvas = document.createElement("canvas");
      canvas.width = this.naturalWidth;
      canvas.height = this.naturalHeight;

      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      canvas.getContext("2d").drawImage(this, 0, 0);

      resolve(canvas.toDataURL("image/jpeg"));
    };

    image.src = url;
  })
}

function reset() {
  if (state.progressInterval) {
    clearInterval(state.progressInterval);
    state.progressInterval = null;
  }
  state.generationInProgressing = false;
  state.currentPage = 0;
  state.maxPage = 0;
  state.cancelled = false;
}