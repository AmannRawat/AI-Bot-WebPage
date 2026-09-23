import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import { ChromaClient } from "chromadb";

// dotenv.config();

export const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const chromadbClient = new ChromaClient({path : 'https://localhost:8000'});
chromadbClient.heartbeat();

const WEB_COLLECTION='WEB_SCRAPED_DATA_COLLECTION-1'


async function scrapeWebpage(url = "") {
    const { data } = await axios.get(url);

    const $ = cheerio.load(data);

    const pageHead = $("head").html();
    const pageBody = $("body").html();

    const internalLinks = [];
    const externalLinks = [];
    $('a').each((index, element) => {
        const link = $(element).attr('href')
        if (link === '/' || link === '#') return;
        if (link?.startsWith('http') || link?.startsWith('https')) {
            externalLinks.push(link);
        } else {
            internalLinks.push(link);
        }
    })
    return { head: pageHead, body: pageBody, internalLinks, externalLinks };
}

async function generateVectorEmbeddings({ text }) {
    const response = await ai.models.embedContent({
        model: "gemini-embedding-2",
        contents: text,
        encoding_format: 'FLOAT',
    });
    return response.data[0].embedding;
}

async function insertIntoDb(embeddings,documents,metadata) {

}

async function ingest(url = '') {
    const { head, body, internalLinks} = await scrapeWebpage(url);
    const headEmbedding = await generateVectorEmbeddings({text: head});
    const bodyChunks = chunkText(body); // Made chunks because context window size is limited for embedding content and body was lengthy
    for(const chunk of bodyChunks){
        const bodyEmbedding = await generateVectorEmbeddings({text: chunk});
    }
}

export function chunkText(text, chunkSize = 300) {
  const tokens = text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");

  const chunks = [];

  for (let i = 0; i < tokens.length; i += chunkSize) {
    chunks.push(tokens.slice(i, i + chunkSize).join(" "));
  }

  return chunks;
}

scrapeWebpage("https://prepai-app.vercel.app/").then((data) => {
    console.log(data.head);
    console.log(data.body);
    console.log(data.internalLinks);
    console.log(data.externalLinks);
});