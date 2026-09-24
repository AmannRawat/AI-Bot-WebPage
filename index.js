import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import { ChromaClient } from "chromadb";

// dotenv.config();

export const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const chromadbClient = new ChromaClient({
    host: "localhost",
    port: 8000,
    ssl: false,
});
chromadbClient.heartbeat();

const WEB_COLLECTION = 'WEB_SCRAPED_DATA_COLLECTION-1'

const collection = await chromadbClient.getOrCreateCollection({
    name: WEB_COLLECTION,
});



async function scrapeWebpage(url = "") {
    // Static websites → Axios
    const { data } = await axios.get(url);

    const $ = cheerio.load(data);

    const pageHead = $("head").html();
    const pageBody = $("body").text().replace(/\s+/g, " ").trim();

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
    // Ptinting Embedding
    console.log("Dimension:", response.embeddings[0].values.length);
    console.log("First 5 values:", response.embeddings[0].values.slice(0, 5));
    return response.embeddings[0].values;
}

async function ingest(url = '') {
    const { head, body, internalLinks } = await scrapeWebpage(url);
    const headEmbedding = await generateVectorEmbeddings({ text: head });

    await insertIntoDb({
        id: `${url}-head`,
        embedding: headEmbedding,
        url,
        body: head,
        head
    });

    const bodyChunks = chunkText(body); // Made chunks because context window size is limited for embedding content and body was lengthy
    for (const [chunkIndex, chunk] of bodyChunks.entries()) {
        const bodyEmbedding = await generateVectorEmbeddings({ text: chunk });
        await insertIntoDb({
            id: `${url}-${chunkIndex}`,
            embedding: bodyEmbedding,
            url,
            body: chunk,
            head
        });
    }

    for (const link of internalLinks) {
        const _url = `${url}${link}`;
        await ingest(_url);
    }
}

async function insertIntoDb({ id, embedding, url, body = '', head = '' }) {
    await collection.add({
        ids: [id],
        embeddings: [embedding],
        documents: [body],
        metadatas: [{ url, head }]
    });
    // count the no. of vectors in the collection
    const count = await collection.count();
    console.log("Vectors in DB:", count);
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

await ingest('https://prepai-app.vercel.app/');

async function chat(question = '') {
    const questionEmbedding = await generateVectorEmbeddings({ text: question });
    const collectionResult = await collection.query({
        queryEmbeddings: [questionEmbedding],
        nResults: 3,
        include: ['metadatas', 'documents']
    })

    console.log("Retrieved:", JSON.stringify(collectionResult, null, 2));

    const body = collectionResult.documents[0]
        .filter((e) => e && e.trim() !== "");

    const url = collectionResult.metadatas[0]
        .map((e) => e.url)
        .filter((e) => e && e.trim() !== "");

    const chatSession = ai.chats.create({
        model: "gemini-3.5-flash-lite",
        config: {
            systemInstruction: `You are an AI support agent expert in providing support to users on behalf of the webpage. Answer the user's question only from the retrieved context.`
        },
        history: []
    });

    const response = await chatSession.sendMessage({
        message: `
    Query: ${question}
    URLs: ${url.join(", ")}
    Retrieved Context: ${body.join("\n\n")}
`
    });

    console.log({
        message: `🤖 AI Support Agent: ${response.text}`,
        SourceURL: url[0],
    });
}

await chat("What PrepAi App Does?");