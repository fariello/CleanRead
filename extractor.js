/**
 * CleanRead Content Extractor
 * Runs inside the target webpage after Readability.js is injected.
 * Extracts only the essential human-readable text and converts it to clean Markdown
 * (no images, no raw link URLs, no navbars/popups/footers).
 */
(() => {
  function cleanWhitespace(str) {
    return (str || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  /**
   * Normalizes modern React/MDX/Mintlify/Docusaurus DOM patterns into standard semantic HTML
   * BEFORE stripping buttons/links or running Readability, so changelogs, cards, steps,
   * and [data-as="p"] spans are preserved as real headings and paragraphs.
   */
  function normalizeModernDocsDom(doc) {
    // 1. Convert <span data-as="p"> (used by Mintlify & MDX renderers) into real <p> elements
    for (const spanP of Array.from(doc.querySelectorAll('[data-as="p"]'))) {
      const p = doc.createElement("p");
      while (spanP.firstChild) {
        p.appendChild(spanP.firstChild);
      }
      spanP.replaceWith(p);
    }

    // 2. Convert changelog date/version badges (often <button data-component-part="update-label">) into <h2>
    for (const badge of Array.from(
      doc.querySelectorAll('[data-component-part="update-label"]')
    )) {
      const h2 = doc.createElement("h2");
      h2.textContent = cleanWhitespace(badge.textContent);
      badge.replaceWith(h2);
    }

    // 3. Convert changelog update descriptions into <p>
    for (const desc of Array.from(
      doc.querySelectorAll('[data-component-part="update-description"]')
    )) {
      const p = doc.createElement("p");
      p.textContent = cleanWhitespace(desc.textContent);
      desc.replaceWith(p);
    }

    // 4. Convert card/step/accordion titles into <h3> if they aren't already headings
    for (const titleEl of Array.from(
      doc.querySelectorAll(
        '[data-component-part="card-title"], [data-component-part="step-title"], [data-component-part="accordion-title"]'
      )
    )) {
      if (!/^h[1-6]$/i.test(titleEl.tagName)) {
        const h3 = doc.createElement("h3");
        h3.textContent = cleanWhitespace(titleEl.textContent);
        titleEl.replaceWith(h3);
      }
    }

    // 5. Remove heading anchor jump-links (e.g. #permalink icons with zero-width spaces)
    for (const jumpLink of Array.from(
      doc.querySelectorAll(
        'a[href^="#"][aria-label^="Navigate to"], a.anchor, a.header-anchor, a.hash-link'
      )
    )) {
      jumpLink.remove();
    }

    // 6. Unwrap block-level card <a> links into <div> so Readability doesn't discard them for "high link density"
    for (const a of Array.from(doc.querySelectorAll("a"))) {
      const isCard =
        a.classList.contains("card") ||
        a.querySelector(
          "h1, h2, h3, h4, h5, h6, p, [data-component-part='card-content-container']"
        );
      if (isCard) {
        const div = doc.createElement("div");
        while (a.firstChild) {
          div.appendChild(a.firstChild);
        }
        a.replaceWith(div);
      }
    }
  }

  /**
   * Pre-cleans a cloned document by normalizing modern docs components and removing
   * all navigation chrome, sidebars, tables of contents, popups, media, and interactive controls.
   */
  function preCleanDocument(doc) {
    normalizeModernDocsDom(doc);

    const removeSelectors = [
      "script", "style", "noscript", "template", "iframe", "frame",
      "object", "embed", "svg", "canvas", "img", "picture", "source",
      "video", "audio", "track", "map", "area", "figure", "figcaption",
      "form", "input", "textarea", "select", "button", "dialog",
      "nav", "footer", "aside",
      "#navbar", "#sidebar", "#sidebar-content", "#navigation-items",
      "#table-of-contents", "#table-of-contents-layout", "#content-side-layout",
      "#page-context-menu", "#pagination", "#footer", "#banner",
      "[data-layout-item='topbar']", "[data-layout-item='banner']",
      "[data-layout-item='sidebar']", "[data-layout-item='toc']",
      "[data-layout-item='toc-content']", "[data-layout-item='side-panel']",
      "[data-component-part='callout-icon']",
      "[role='navigation']", "[role='banner']", "[role='contentinfo']",
      "[role='complementary']", "[role='dialog']", "[role='alertdialog']",
      "[role='search']", "[aria-modal='true']", "[aria-hidden='true']",
      "[hidden]", ".sr-only",
      ".cookie-banner", ".cookie-consent", "#cookie-banner", "#cookie-consent",
      ".newsletter-signup", ".popup", ".modal", ".ad", ".ads", ".advertisement",
      ".social-share", ".share-buttons", ".related-posts", ".recommended",
      "#comments", ".comments", ".comment-section"
    ];

    try {
      const nodes = doc.querySelectorAll(removeSelectors.join(","));
      for (const node of nodes) {
        node.remove();
      }
    } catch (_) {
      // Fallback if a complex selector fails on an older page
      for (const sel of removeSelectors) {
        try {
          for (const n of doc.querySelectorAll(sel)) n.remove();
        } catch (_) {}
      }
    }
  }

  /**
   * Converts a clean DOM subtree into text-only Markdown suitable for screen readers.
   * Links keep only their visible anchor text; images and media are ignored completely.
   */
  function domToMarkdown(root) {
    function processInline(node) {
      if (!node) return "";
      if (node.nodeType === Node.TEXT_NODE) {
        return node.nodeValue
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/\u00A0/g, " ")
          .replace(/[ \t\r\n]+/g, " ");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();
      if (
        [
          "script", "style", "noscript", "svg", "img", "picture",
          "video", "audio", "iframe", "canvas", "button", "input",
          "select", "textarea", "form", "nav", "footer", "aside"
        ].includes(tag)
      ) {
        return "";
      }

      if (tag === "br") return "\n";

      let inner = "";
      for (const child of node.childNodes) {
        inner += processInline(child);
      }

      if (!inner.trim()) return inner;

      if (tag === "strong" || tag === "b") {
        return ` **${inner.trim()}** `;
      }
      if (tag === "em" || tag === "i") {
        return ` *${inner.trim()}* `;
      }
      if (tag === "code") {
        return ` \`${inner.trim()}\` `;
      }
      return inner;
    }

    function normalizeInlineText(text) {
      return text
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/ +\n/g, "\n")
        .replace(/\n +/g, "\n")
        .replace(/ +([.,!?;:])/g, "$1")
        .trim();
    }

    function processBlock(node, listDepth = 0) {
      if (!node) return "";
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = cleanWhitespace(node.nodeValue);
        return txt ? txt : "";
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const tag = node.tagName.toLowerCase();

      if (
        [
          "script", "style", "noscript", "svg", "img", "picture",
          "video", "audio", "iframe", "canvas", "button", "input",
          "select", "textarea", "form", "nav", "footer", "aside",
          "dialog", "template", "map", "object", "embed"
        ].includes(tag)
      ) {
        return "";
      }

      // Headings h1 - h6
      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        const text = normalizeInlineText(processInline(node));
        if (!text) return "";
        return `\n\n${"#".repeat(level)} ${text}\n\n`;
      }

      // Paragraphs
      if (tag === "p") {
        const text = normalizeInlineText(processInline(node));
        if (!text) return "";
        return `\n\n${text}\n\n`;
      }

      // Preformatted code blocks
      if (tag === "pre") {
        const raw = cleanWhitespace(node.textContent || "");
        if (!raw) return "";
        return `\n\n\`\`\`\n${(node.textContent || "").trim()}\n\`\`\`\n\n`;
      }

      // Blockquotes
      if (tag === "blockquote") {
        const inner = processChildren(node, listDepth).trim();
        if (!inner) return "";
        const quoted = inner
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n");
        return `\n\n${quoted}\n\n`;
      }

      // Unordered & Ordered Lists
      if (tag === "ul" || tag === "ol") {
        const isOrdered = tag === "ol";
        let itemsOut = [];
        let index = 1;
        for (const child of node.children) {
          if (child.tagName && child.tagName.toLowerCase() === "li") {
            const prefix = isOrdered ? `${index}. ` : "- ";
            const indent = "  ".repeat(listDepth);
            let liInline = [];
            let nestedBlocks = [];

            for (const liChild of child.childNodes) {
              if (
                liChild.nodeType === Node.ELEMENT_NODE &&
                ["ul", "ol"].includes(liChild.tagName.toLowerCase())
              ) {
                nestedBlocks.push(processBlock(liChild, listDepth + 1).trimEnd());
              } else if (
                liChild.nodeType === Node.ELEMENT_NODE &&
                ["p", "div"].includes(liChild.tagName.toLowerCase())
              ) {
                liInline.push(normalizeInlineText(processInline(liChild)));
              } else {
                liInline.push(processInline(liChild));
              }
            }

            const mainText = normalizeInlineText(liInline.join(" "));
            let line = "";
            if (mainText) {
              line = `${indent}${prefix}${mainText}`;
            }
            if (nestedBlocks.length > 0) {
              const nestedStr = nestedBlocks.filter(Boolean).join("\n");
              line = line ? `${line}\n${nestedStr}` : nestedStr;
            }
            if (line.trim()) {
              itemsOut.push(line);
              index++;
            }
          }
        }
        if (itemsOut.length === 0) return "";
        return listDepth === 0
          ? `\n\n${itemsOut.join("\n")}\n\n`
          : `\n${itemsOut.join("\n")}`;
      }

      // Tables
      if (tag === "table") {
        const rows = Array.from(node.querySelectorAll("tr"));
        const lines = [];
        for (const tr of rows) {
          const cells = Array.from(tr.querySelectorAll("th, td"))
            .map((cell) => normalizeInlineText(processInline(cell)))
            .filter(Boolean);
          if (cells.length > 0) {
            lines.push(cells.join(" | "));
          }
        }
        if (lines.length === 0) return "";
        return `\n\n${lines.join("\n")}\n\n`;
      }

      // Definition lists (dl, dt, dd)
      if (tag === "dt") {
        const text = normalizeInlineText(processInline(node));
        return text ? `\n\n**${text}**\n` : "";
      }
      if (tag === "dd") {
        const text = normalizeInlineText(processInline(node));
        return text ? `${text}\n\n` : "";
      }

      if (tag === "hr") {
        return "\n\n---\n\n";
      }

      if (tag === "br") {
        return "\n";
      }

      // Generic container (div, section, article, main, header, etc.)
      const hasBlockChildren = Array.from(node.children).some((el) =>
        [
          "p", "div", "section", "article", "main", "header",
          "h1", "h2", "h3", "h4", "h5", "h6",
          "ul", "ol", "li", "table", "blockquote", "pre", "dl", "hr"
        ].includes(el.tagName.toLowerCase())
      );

      if (!hasBlockChildren) {
        const text = normalizeInlineText(processInline(node));
        return text ? `\n\n${text}\n\n` : "";
      }

      return processChildren(node, listDepth);
    }

    function processChildren(parent, listDepth) {
      let out = "";
      for (const child of parent.childNodes) {
        out += processBlock(child, listDepth);
      }
      return out;
    }

    const rawMarkdown = processChildren(root, 0);
    return rawMarkdown
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  try {
    let title = cleanWhitespace(document.title || "");

    // Candidate 1: Mozilla Readability on pre-cleaned document
    let readabilityMarkdown = "";
    if (typeof Readability === "function") {
      const docForReadability = document.cloneNode(true);
      preCleanDocument(docForReadability);
      const reader = new Readability(docForReadability, {
        charThreshold: 80,
        keepClasses: false
      });
      const article = reader.parse();
      if (article && article.content) {
        if (article.title) {
          title = cleanWhitespace(article.title);
        }
        const tempContainer = document.createElement("div");
        tempContainer.innerHTML = article.content;
        readabilityMarkdown = domToMarkdown(tempContainer);
      }
    }

    // Candidate 2: Direct extraction from explicit semantic content container
    // (Catches Changelogs, Card Grids, and Multi-Section Docs that Readability truncates)
    let semanticMarkdown = "";
    const docForSemantic = document.cloneNode(true);
    preCleanDocument(docForSemantic);
    const semanticRoot =
      docForSemantic.querySelector(
        "#content-area, #content, .mdx-content, article, main, [role='main']"
      ) || docForSemantic.body;
    if (semanticRoot) {
      semanticMarkdown = domToMarkdown(semanticRoot);
    }

    // Pick whichever candidate captured the full content without truncating sections
    let markdownBody = readabilityMarkdown;
    if (
      !markdownBody ||
      markdownBody.length < 120 ||
      semanticMarkdown.length > markdownBody.length * 1.35
    ) {
      markdownBody = semanticMarkdown || readabilityMarkdown;
    }

    // Final fallback to visible text if DOM extraction was still empty
    if (!markdownBody && document.body) {
      markdownBody = (document.body.innerText || "")
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    // Prepend the page/article title as # Heading if not already at the top
    if (title && markdownBody) {
      const firstLine = markdownBody.split("\n")[0].replace(/^#+\s*/, "").trim();
      if (
        !firstLine ||
        (!title.toLowerCase().includes(firstLine.toLowerCase()) &&
          !firstLine.toLowerCase().includes(title.toLowerCase()))
      ) {
        markdownBody = `# ${title}\n\n${markdownBody}`;
      }
    }

    return {
      ok: true,
      title: title || "untitled",
      markdownBody: markdownBody || ""
    };
  } catch (err) {
    return {
      ok: false,
      error: String(err && err.message ? err.message : err),
      title: document.title || "untitled",
      markdownBody: document.body ? (document.body.innerText || "").trim() : ""
    };
  }
})();
