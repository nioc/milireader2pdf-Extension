const { jsPDF } = window.jspdf;

import {
  DocumentGenerator,
  GetImageError,
  GetMaterialError,
  KeyNotFoundError,
} from "./core.js";

/** @type {DocumentGeneratorConfig} */
const generatorConfig = {
  addInvisibleText: true,
  fetchArticle: true,
  invisibleTextFontSize: 20,
  addArticleOutlines: true,
  filenamePattern: "{{provider}}_{{publication_date}}",
};

// UI functions
const actionBtn = document.getElementById("actionBtn");
const messagesContainer = document.getElementById("messagesContainer");
let progressMessageElement = null

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
  return line;
}

function addProgressMessage(text) {
  if (!progressMessageElement) {
    progressMessageElement = addMessage(text, "success");
  }
  progressMessageElement.textContent = text;
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

// business logic functions

/**
 * Update document generator configuration from UI form
 */
function updateConfig() {
  generatorConfig.filenamePattern = document.getElementById("filenamePattern").value;
  generatorConfig.fetchArticle = document.getElementById("fetchArticle").checked;
  generatorConfig.addInvisibleText = document.getElementById("addInvisibleText").checked;
  generatorConfig.addArticleOutlines = document.getElementById("addArticleOutlines").checked;
  generatorConfig.invisibleTextFontSize = parseInt(document.getElementById("invisibleTextFontSize").value) || 20;
}

/**
 * Cancel current document generation
 */
function cancelPdfGeneration() {
  generator.stop();
  setButtonToGenerationMode();
  clearMessages();
  addMessage("Générer le PDF en cliquant sur le bouton ci-dessus");
}

/**
 * Request a document generation
 */
async function startPdfGeneration() {
  updateConfig();
  if (generator.isRunning()) {
    return;
  }
  setButtonToCancelMode();
  const html = await getTabHtml();
  clearMessages();
  addMessage("Obtention des informations en cours...");
  addMessage("Laissez l'extension ouverte jusqu'à la fin");
  try {
    await generator.start(generatorConfig, html);
    setButtonToGenerationMode();
    addMessage("Génération du PDF terminée", "success");
  } catch (error) {
    console.error(error);
    setButtonToGenerationMode();
    if (error instanceof KeyNotFoundError) {
      addMessage("Clé de journal non trouvée", "error");
    } else if (error instanceof GetMaterialError) {
      if (error.status === 403 || error.status === 401) {
        addMessage("Erreur obtention material.json: rafraichissez la page (F5)", "error");
      } else {
        addMessage(`Erreur obtention material.json: ${error.status}`, "error");
      }
    } else if (error instanceof GetImageError) {
        addMessage(`Erreur chargement de l'image : ${error.url}`, "error");
    } else {
      addMessage(`Erreur inattendue ${error.message}`, "error");
    }
  }
}

/**
 * Returns the html of the current tab
 * @returns {Promise<string>}
 */
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

// bootstrap
const generator = new DocumentGenerator(jsPDF, addMessage, addProgressMessage);
window.onload = () => {
  setButtonToGenerationMode();
  clearMessages();
  addMessage("Générer le PDF en cliquant sur le bouton ci-dessus");
}
