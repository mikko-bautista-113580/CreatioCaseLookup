/**
 * Hyperlinks in case rich text.
 *
 * Customers link mock-up files (e.g. FTP-hosted PDFs) from the request email,
 * usually wrapped in Outlook SafeLinks. These used to be flattened to their
 * label, so the file was nowhere to be found in the app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToSegments, plainMentions, LINK_OPEN, LINK_SEP, LINK_CLOSE } from "./caseLookup.js";

const text = (html: string) =>
  htmlToSegments(html)
    .map((s) => (s.type === "text" ? s.text : ""))
    .join("\n");

test("SafeLinks-wrapped link keeps its label and the real target URL", () => {
  const real = "https://smsd-ca.client.factsmgt.com/FTP/smsd-ca/custommockups/Grade%201.BlankReportCard%202.pdf";
  const html =
    `<a href="https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(real)}&amp;data=05%7C02&amp;reserved=0" ` +
    `style="color:blue">Grade 1.BlankReportCard 2.pdf</a><br />`;
  assert.equal(text(html), LINK_OPEN + real + LINK_SEP + "Grade 1.BlankReportCard 2.pdf" + LINK_CLOSE);
  assert.equal(plainMentions(text(html)), `Grade 1.BlankReportCard 2.pdf <${real}>`);
});

test("mailto link flattens to the bare address", () => {
  const html = `<a href="mailto:a@b.com">a@b.com</a>`;
  assert.equal(plainMentions(text(html)), "a@b.com");
});

test("unsafe hrefs are dropped, label text kept", () => {
  assert.equal(text(`<a href="javascript:alert(1)">click</a>`), "click");
  assert.equal(text(`<a href="/relative/path">rel</a>`), "rel");
});
