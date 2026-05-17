import { Journal } from "./journal.js";

export class GenericError {
  constructor(message) {
    this.message = message;
    this.name = "GenericError";
  }
}

export class KeyNotFoundError extends GenericError {
  constructor() {
    super("Key not found in material");
    this.name = "KeyNotFoundError";
  }
}

export class GetMaterialError extends GenericError {
  constructor(status) {
    super("Error retrieving material.json");
    this.name = "GetMaterialError";
    this.status = status;
  }
}

export class GetImageError extends GenericError {
  constructor(url, error) {
    super("Error retrieving material.json");
    this.name = "GetImageError";
    this.url = url;
    this.rootError = error;
  }
}

/**
 * @typedef {Object} DocumentGeneratorConfig
 *
 * @property {boolean} addInvisibleText
 *  Add the article text to the page as hidden content for indexing, searching and copying and pasting.
 *
 * @property {boolean} fetchArticle
 *  Retrieve the content of an article from an external source.
 *
 * @property {number} invisibleTextFontSize
 *  Font size for invisible text.
 *
 * @property {boolean} addArticleOutlines
 *  Add the article text as a sub-item under the article outline.
 *
 * @property {string} filenamePattern
 *  Pattern for the name of the generated file.
 *
 *  Allowed placeholders in double brackets (ex: {{provider}}) are:
 *    - provider
 *    - publication_date
 *    - issue_number
 *    - title
 */

/**
 * @typedef {Object} State
 *
 * @property {boolean} generationInProgressing
 *  Is a document currently being generated?
 *
 * @property {number} currentPage
 *  The current page being processed by the instance.
 *
 * @property {number} maxPage
 *  The total number of pages to be processed.
 *
 * @property {boolean} cancelled
 *  The generation request has been cancelled.
 */

export class DocumentGenerator {

  /** @type {DocumentGeneratorConfig} Document generator configuration */
  config

  /** @type {State} Store instance state */
  state

  /** @type {Journal} Journal instance */
  journal

  /** @type {jsPDF} PDF document */
  pdf

  /** @type {*} jsPDF library */
  jsPDF

  /** @type {(string) => void} Callback function invoked for a generic event */
  genericNotifier

  /** @type {(string) => void} Callback function invoked for a progress event */
  progressNotifier

  /**
   * Instanciate a new DocumentGenerator
   * @param {*} jsPDF Injection of the jsPDF dependency, which is not ES-compatible
   * @param {(string) => void} genericNotifier Callback function invoked for a generic event
   * @param {(string) => void} progressNotifier Callback function invoked for a progress event
   */
  constructor(jsPDF, genericNotifier = () => null, progressNotifier = () => null) {
    this.jsPDF = jsPDF;
    this.genericNotifier = genericNotifier;
    this.progressNotifier = progressNotifier;
    /** @type {DocumentGeneratorConfig} */
    this.config = {
      addInvisibleText: true,
      fetchArticle: true,
      invisibleTextFontSize: 20,
      addArticleOutlines: true,
      filenamePattern: "{{provider}}_{{publication_date}}",
    };
    this.reset();
  }

  /**
   * Indicates whether a document is currently being processed
   * @returns {boolean}
   */
  isRunning() {
    return this.state.generationInProgressing;
  }

  /**
   * Resets the generator to its default settings 
   */
  reset() {
    this.state = {
      generationInProgressing: false,
      currentPage: 0,
      maxPage: 0,
      cancelled: false,
    };
    this.journal = new Journal();
  }

  /**
   * Start document generation
   * @param {DocumentGeneratorConfig} config
   * @param {string} html
   */
  async start(config, html) {
    // check there is no running job for this instance
    if (this.state.generationInProgressing) {
      throw new GenericError("Traitement en cours");
    }
    this.config = config;

    // reset instance
    this.reset();
    this.state.generationInProgressing = true;

    // get key and material.json
    this.journal.getJournalKey(html);
    if (!this.journal.key_find) {
      this.reset();
      throw new KeyNotFoundError();
    }
    this.genericNotifier(`Clé de journal trouvée: ${this.journal.journal_key}`, "success");
    await new Promise((resolve, reject) => {
      this.journal.getMaterialJSON(
        (error) => {
          this.reset();
          reject(new GetMaterialError(error.status));
        },
        () => resolve()
      );
    });
    console.debug(this.journal.material);
    this.genericNotifier(`Material.json obtenu: journal ${this.journal.material.metadata.issue_number} du ${this.journal.material.metadata.publication_localized_date}`, "success");

    // get pages and declare progress callback
    const pagesLength = this.journal.material.pages.length;
    await this.generatePages((page) => {
      this.progressNotifier(`Pages en cours de génération (${page}/${pagesLength})`);
    });
  }

  /**
   * Cancel the generation of the current document
   */
  stop () {
    this.reset();
    this.state.cancelled = true;
  }

  /**
   * Generate the document using the information obtained
   * @param {(number) => void} callbackPageUpdate Callback function invoked to return the current page
   */
  async generatePages(callbackPageUpdate) {
    // get first page in high definition
    const firstHd = this.journal.material.pages[0].hd;
    this.pdf = new this.jsPDF("p", "px", [firstHd.width, firstHd.height]);

    const title = this.handleMetadata();
    
    // create root outline
    const rootOutline = this.pdf.outline.add(null, title, null);

    let pageIndex = 1;
    this.state.maxPage = this.journal.material.pages.length;
    // for each page
    for (const page of this.journal.material.pages) {
      const hd = page.hd;
      this.state.currentPage = pageIndex;
      callbackPageUpdate(pageIndex);

      // the page consists of images arranged in vertical (column) and horizontal (row) tiles: retrieval of each tile
      let tileWidth = hd.tile_height; // @TODO : check requested behavior or bug?
      // for each column (vertical)
      for (let col = 0; col < hd.tile_col_count; col++) {
        if ((col + 1) * hd.tile_width > hd.width) {
          tileWidth = hd.width % hd.tile_width;
        }
        let tileHeight = hd.tile_width; // @TODO : check requested behavior or bug?
        // for each row (horizontal)
        for (let row = 0; row < hd.tile_row_count; row++) {
          if (this.state.cancelled) {
            this.reset();
            return;
          }

          if ((row + 1) * hd.tile_height > hd.height) {
            tileHeight = hd.height % hd.tile_height;
          }

          // construct image (cell as defined by column and row) url ang request it
          let imgUrl = `${this.journal.journal_key}/${hd.path}/tile${(col + "").padStart(2, "0")}x${(row + "").padStart(2, "0")}.jpeg`;
          console.debug(imgUrl);
          let image;
          try {
            image = await getDataUri(imgUrl);
          } catch (error) {
            this.reset();
            throw new GetImageError(imgUrl, error);
          }

          this.pdf.addImage(image, "JPEG", (hd.tile_width * col), (hd.tile_height * row), tileWidth, tileHeight);
          console.debug(`row${row}, col${col}: width${tileWidth}, height:${tileHeight}`);
        }
      }

      // add outlines and invisible text
      const pageOutline = this.pdf.outline.add(rootOutline, `Page ${pageIndex}`, { pageNumber: pageIndex });
      if (this.journal.material.boxes) {
        for (const box of this.journal.material.boxes.filter((box) => box.page === pageIndex && box.type === "article")) {
          // for each article box displayed on the page, retrieve the text content of the article
          const article = this.journal.material.articles[box.target]
          const paragraphs = await this.getArticleParagraphs(`${this.journal.journal_key}/${article.url}`);
          await this.addInvisibleText(hd, box, article.abstract, paragraphs);
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
            const articleOutline = this.pdf.outline.add(pageOutline, title, { pageNumber: pageIndex });
            if (this.config.addArticleOutlines) {
              paragraphs.forEach((p) => this.pdf.outline.add(articleOutline, p, { pageNumber: pageIndex }));
            }
          }
        }
      }

      pageIndex++;
      if (pageIndex <= this.journal.material.pages.length) {
        // add a page only if the journal is not complete
        this.pdf.addPage();
      }
    }
    // save PDF file
    let filename = this.config.filenamePattern
      .replaceAll("{{provider}}", this.journal.material.metadata.provider ?? "")
      .replaceAll("{{title}}", this.journal.material.metadata.title ?? "")
      .replaceAll("{{issue_number}}", this.journal.material.metadata.issue_number ?? "")
      .replaceAll("{{publication_date}}", this.journal.material.metadata.publication_date ?? "")
    this.pdf.save(filename);
    this.reset();
  }

  /**
   * Handle metadata from material.json and store it in PDF properties
   * @returns {string} Title
   */
  handleMetadata() {
    // handle pdf properties
    const titleParts = [];
    const material = this.journal.material
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
    this.pdf.setProperties(properties);
    if (material.metadata.publication_date) {
      const publicationDate = new Date(material.metadata.publication_date);
      this.pdf.setCreationDate(publicationDate);
    }
    return properties.title ?? 'Journal'
  }

  /**
   * Retrieves the content of an article and returns it as an array of paragraphs
   * @param {string} url Article URL
   * @returns {Promise<string[]>}
   */
  async getArticleParagraphs(url) {
    let paragraphs = []
    if (this.config.fetchArticle) {
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
        this.genericNotifier("Article non récupéré")
      }
    }
    return paragraphs;
  }

  /**
   * Invisibly adds the article text to its location
   * @param {*} page Page definition
   * @param {*} box Defining the item's position
   * @param {*} text Abstract of the article
   * @param {*} paragraphs Array of the article's paragraphs
   */
  async addInvisibleText(page, box, text, paragraphs) {
    if (this.config.addInvisibleText) {
      let textToInsert = paragraphs.length > 0 ? paragraphs.join("\n\n") : text
      // console.debug(textToInsert)
      const x = Math.round(box.left * page.width);
      const y = Math.round(box.top * page.height);
      const w = Math.round(box.width * page.width);
      this.pdf.saveGraphicsState();
      this.pdf.setGState(this.pdf.GState({ opacity: 0 }));
      this.pdf.setFontSize(this.config.invisibleTextFontSize);
      this.pdf.text(textToInsert, x, y, {
        align: "left",
        maxWidth: w,
        renderingMode: "invisible",
      });
      this.pdf.restoreGraphicsState();
    }
  }
}

/**
 * Removes unwanted characters from the text
 * @param {string} html 
 * @returns {string}
 */
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

/**
 * Returns a data URL containing a representation of the image in jpeg format
 * @param {string} url 
 * @returns {string}
 */
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
