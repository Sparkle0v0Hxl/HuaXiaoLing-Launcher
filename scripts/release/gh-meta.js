const T=process.env.GH_TOKEN, R="Sparkle0v0Hxl/HuaXiaoLing-Launcher";
(async()=>{
  const body={
    description:"花筱灵启动器 · 原神 / 崩坏：星穹铁道 / 绝区零 / 异环 / 明日方舟：终末地 多服务器启动器｜硬链接切换、官方更新、抽卡记录、弹幕点歌、完全便携",
    homepage:"https://github.com/Sparkle0v0Hxl/HuaXiaoLing-Launcher/releases/latest",
    topics:["electron","windows","launcher","genshin-impact","honkai-star-rail","zenless-zone-zero","honkai-impact-3rd","arknights-endfield","neverness-to-everness","portable","hardlink"]
  };
  // PATCH /repos 管 description 和 homepage（topics 字段会被忽略，单独走 /topics 端点）
  const r=await fetch("https://api.github.com/repos/"+R,{method:"PATCH",headers:{"user-agent":"hx","accept":"application/vnd.github+json",authorization:"Bearer "+T,"content-type":"application/json"},body:JSON.stringify({description:body.description,homepage:body.homepage})});
  const j=await r.json();
  console.log("repo:", r.status, j.description, "|", j.homepage);
  // PATCH /repos 会忽略 topics 字段，topics 必须走专门端点
  const t = await fetch("https://api.github.com/repos/"+R+"/topics",{method:"PUT",headers:{"user-agent":"hx","authorization":"Bearer "+T,"content-type":"application/json"},body:JSON.stringify({names:body.topics})});
  const tj = await t.json();
  console.log("topics:", t.status, (tj.names||[]).join(", "));
})();
