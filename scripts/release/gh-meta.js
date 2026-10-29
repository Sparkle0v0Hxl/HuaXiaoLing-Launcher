const T=process.env.GH_TOKEN, R="Sparkle0v0Hxl/HuaXiaoLing-Launcher";
(async()=>{
  const body={
    description:"花筱灵启动器 · 原神 / 崩坏：星穹铁道 / 绝区零 / 异环 / 明日方舟：终末地 多服务器启动器｜硬链接切换、官方更新、抽卡记录、弹幕点歌、完全便携",
    homepage:"https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/releases/latest",
    topics:["electron","windows","launcher","genshin-impact","honkai-star-rail","zenless-zone-zero","honkai-impact-3rd","arknights-endfield","neverness-to-everness","portable","hardlink"]
  };
  const r=await fetch("https://api.github.com/repos/"+R,{method:"PATCH",headers:{"user-agent":"hx","accept":"application/vnd.github+json",authorization:"Bearer "+T,"content-type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json();
  console.log("status:",r.status);
  if(r.ok){console.log("description:",j.description);console.log("homepage:",j.homepage);console.log("topics:",(j.topics||[]).join(", "));}
  else console.log("err:",JSON.stringify(j).slice(0,300));
})();
