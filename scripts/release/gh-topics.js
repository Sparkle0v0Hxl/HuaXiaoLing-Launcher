const T=process.env.GH_TOKEN, R="Sparkle0v0Hxl/HuaXiaoLing-Launcher";
const topics=["electron","windows","launcher","genshin-impact","honkai-star-rail","zenless-zone-zero","endfield","neverness-to-everness","portable","hardlink"];
(async()=>{
  const r=await fetch("https://api.github.com/repos/"+R+"/topics",{method:"PUT",headers:{"user-agent":"hx",accept:"application/vnd.github.mercy-preview+json",authorization:"Bearer "+T,"content-type":"application/json"},body:JSON.stringify({names:topics})});
  const j=await r.json();
  console.log("status:",r.status);
  console.log("topics:",(j.names||j.topics||[]).join(", ")||JSON.stringify(j).slice(0,200));
})();
