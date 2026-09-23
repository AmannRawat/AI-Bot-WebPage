import axios from "axios";
import * as cheerio from "cheerio";

async function scrapeWebpage(url = "") {
  const { data } = await axios.get(url);

  const $ = cheerio.load(data);

  const pageHead = $("head").html();
  const pageBody = $("body").html();

  const internalLinks = [];
  const externalLinks = [];
  $('a').each((index, element) => {
    const link = $(element).attr('href')
    if(link==='/' || link==='#') return;
    if (link?.startsWith('http') || link?.startsWith('https')) {
      externalLinks.push(link);
    } else {
      internalLinks.push(link); 
    }
  })
return {head : pageHead, body : pageBody, internalLinks, externalLinks};
}


scrapeWebpage("https://prepai-app.vercel.app/").then((data)=>{
    console.log(data.head);
    console.log(data.body);
    console.log(data.internalLinks);
    console.log(data.externalLinks);
});