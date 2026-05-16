const { jsPDF } = window.jspdf;

const config = {
  addInvisibleText: true,
  fetchArticle: true,
  fontSize: 20,
};

// store information
const state = {
  generationInProgressing: false,
  currentPage: 0,
  maxPage: 0,
  cancelled: false,
};

// UI functions
const actionBtn = document.getElementById("actionBtn");
const messagesContainer = document.getElementById("messagesContainer");

function clearMessages() {
  messagesContainer.innerHTML = "";
}

function addMessage(text, classname) {
  const line = document.createElement("p");
  if (classname) {
    line.classList.add(classname);
  }
  line.textContent = text;
  messagesContainer.appendChild(line);
}

function setButtonToGenerationMode() {
  actionBtn.classList.remove("cancel");
  actionBtn.textContent = "Générer le PDF";
  actionBtn.onclick = startPdfGeneration
}

function setButtonToCancelMode() {
  actionBtn.classList.add("cancel");
  actionBtn.textContent = "Annuler la génération";
  actionBtn.onclick = cancelPdfGeneration
}

// bootstrap
window.onload = () => {
  setButtonToGenerationMode();
  clearMessages();
  addMessage("Générer le PDF en cliquant sur le bouton ci-dessus");
}

// business logic functions
function cancelPdfGeneration() {
  reset();
  state.cancelled = true;
  setButtonToGenerationMode();
  clearMessages();
  addMessage("Générer le PDF en cliquant sur le bouton ci-dessus");
}

async function startPdfGeneration() {
  try {
    if (state.generationInProgressing) {
      return;
    }
    reset();
    state.generationInProgressing = true;
    setButtonToCancelMode();
    let journal = new Journal();
    const html = await getTabHtml();
    clearMessages();
    addMessage("Obtention des informations en cours...");
    addMessage("Laissez l'extension ouverte jusqu'à la fin");
    journal.getJournalKey(html);
    if (!journal.key_find) {
      reset();
      setButtonToGenerationMode();
      addMessage("Clé de journal non trouvée", "error");
      return;
    }

    addMessage(`Clé de journal trouvée: ${journal.journal_key}`, "success");
    journal.getMaterialJSON((error) => {
      reset();
      setButtonToGenerationMode();
      if (error.status === 403) {
        addMessage("Erreur obtention material.json: rafraichissez la page (F5)", "error");
      } else {
        addMessage(`Erreur obtention material.json: ${error.status}`, "error");
      }

    }, (material) => {
      console.debug(material);
      addMessage(`Material.json obtenu: journal du ${material.metadata.publication_localized_date}`, "success");
      const progressLine = document.createElement("p");
      progressLine.classList.add("success");
      const pagesLength = material.pages.length;
      messagesContainer.appendChild(progressLine);
      generatePages(journal.journal_key, journal.material, (page) => {
        progressLine.textContent = `Pages en cours de génération (${page}/${pagesLength})`;
        if (page === pagesLength) {
          setButtonToGenerationMode();
          addMessage("Génération du PDF terminée", "success");
        }
      })
    });
  } catch (err) {
    reset();
    setButtonToGenerationMode();
    addMessage(`Erreur inattendue ${err.message}`, "error");
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

async function generatePages(journalKey, material, callbackUpdate) {
  const firstHd = material.pages[0].hd;
  const doc = new jsPDF("p", "px", [firstHd.width, firstHd.height]);

  const rootOutline = handleMetadata(doc, material)

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
          setButtonToGenerationMode();
          addMessage(`Erreur chargement image : ${imgUrl}`, "error");
          return;
        }

        doc.addImage(image, "JPEG", (hd.tile_width * col), (hd.tile_height * row), tileWidth, tileHeight);
        console.debug(`row${row}, col${col}: width${tileWidth}, height:${tileHeight}`);
      }
    }

    // add outlines and invisible text
    const pageOutline = doc.outline.add(rootOutline, `Page ${pageIndex}`, { pageNumber: pageIndex });
    if (material.boxes) {
      for (const box of material.boxes.filter((box) => box.page === pageIndex && box.type === "article")) {
        const article = material.articles[box.target]
        const paragraphs = await getArticleParagraphs(`${journalKey}/${article.url}`);
        await addInvisibleText(doc, hd, box, article.abstract, paragraphs);
        const outlineTitleParts = []
        if (article.rubrics?.length) {
          outlineTitleParts.push(article.rubrics[0])
        }
        if (article.title) {
          outlineTitleParts.push(article.title)
        }
        let title = ""
        if (article.rubrics?.length) {
          title = outlineTitleParts.join(" - ")
          const articleOutline = doc.outline.add(pageOutline, title, { pageNumber: pageIndex });
          paragraphs.forEach((p) => doc.outline.add(articleOutline, p, { pageNumber: pageIndex }));
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

function handleMetadata(doc, material) {
  // handle pdf properties
  const titleParts = [];
  if (material.metadata.title) {
    titleParts.push(material.metadata.title);
  }
  if (material.metadata.issue_number) {
    titleParts.push(material.metadata.issue_number);
  }
  const properties = {};
  if (titleParts.length) {
    properties.title = titleParts.join(" - ");
  }
  if (material.metadata.provider) {
    properties.author = material.metadata.provider;
  }
  doc.setProperties(properties);
  if (material.metadata.publication_date) {
    const publicationDate = new Date(material.metadata.publication_date);
    doc.setCreationDate(publicationDate);
  }
  // create root outline
  return doc.outline.add(null, properties.title ?? 'Journal', null);
}

async function getArticleParagraphs(url) {
  let paragraphs = []
  if (config.fetchArticle) {
    try {
      const response = await fetch(url);
      const articleContent = await response.json();
      paragraphs = [
        cleanTextWithParagraphs(articleContent.title || ""),
        ...(articleContent?.content?.sections
          ?.flatMap((section) => section.items || [])
          .filter((item) => item.type === "text" && item.class === "paragraph")
          .map((item) => cleanTextWithParagraphs(item.content)) || [])
      ];
    } catch (error) {
      console.warn("Erreur fetch article", url, error);
    }
  }
  return paragraphs;
}

async function addInvisibleText(doc, hd, box, text, paragraphs) {
  if (config.addInvisibleText) {
    let textToInsert = paragraphs.length > 0 ? paragraphs.join("\n\n") : text
    // console.debug(textToInsert)
    const x = Math.round(box.left * hd.width);
    const y = Math.round(box.top * hd.height);
    const w = Math.round(box.width * hd.width);
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0 }));
    doc.setFontSize(config.fontSize);
    doc.text(textToInsert, x, y, {
      align: "left",
      maxWidth: w,
      renderingMode: "invisible",
    });
    doc.restoreGraphicsState();
  }
}

function cleanTextWithParagraphs(html) {
  if (!html) return "";

  // Replace <br>
  html = html.replace(/<br\s*\/?>/gi, "\n");

  // Replace html paragraphs
  html = html.replace(/<\/p>/gi, "\n\n");
  html = html.replace(/<p[^>]*>/gi, "");

  // Delete others HTML tags
  let text = html.replace(/<[^>]+>/g, " ");

  // Decode HTML entities
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  text = textarea.value;

  // Delete invisibles characters
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");

  // Normalize spaces
  text = text.replace(/[ \t]+/g, " ");

  // Normalize new lines
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

function getDataUri(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";

    image.onload = function () {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = this.naturalWidth;
        canvas.height = this.naturalHeight;
  
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(this, 0, 0);
  
        resolve(canvas.toDataURL("image/jpeg"));
      } catch (error) {
        reject(error);
      }
    };

    image.onerror = function (error) {
      reject(new Error(`Erreur chargement image : ${url}`));
    };

    image.src = url;
  })
}

function reset() {
  state.generationInProgressing = false;
  state.currentPage = 0;
  state.maxPage = 0;
  state.cancelled = false;
}