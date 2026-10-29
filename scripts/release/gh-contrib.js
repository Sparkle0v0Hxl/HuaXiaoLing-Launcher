const T=process.env.GH_TOKEN, R="Sparkle0v0Hxl/HuaXiaoLing-Launcher";
async function get(url){
  for(let i=0;i<6;i++){
    try{
      const r=await fetch(url,{headers:{"user-agent":"hx",accept:"application/vnd.github+json",authorization:"Bearer "+T,connection:"close"}});
      return await r.json();
    }catch(e){ await new Promise(s=>setTimeout(s,1500)); }
  }
  return {error:"failed"};
}
(async()=>{
  const j=await get("https://api.github.com/repos/"+R+"/contributors?per_page=100");
  if(!Array.isArray(j)){console.log("err",JSON.stringify(j).slice(0,200));return;}
  for(const c of j) console.log(c.login, "| commits:", c.contributions, "|", c.type);
})();
