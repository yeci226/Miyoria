# @miyoria/skills

她自己的「怎麼做」小文件:每個技能是一個名稱、一行說明與正文,可附腳本。名稱與說明隨時可列出(`index()`),正文要用 `skill_read` 打開才讀。存放在 sandbox 工作區的 `skills/<name>/` 之下,沒有 sandbox 工作區時模組閒置、不開工具;受數量與大小上限限制,進入提示詞的內容一律經過中和並當成資料。腳本用 `workspace_save_script` 存(會審查),用 `workspace_run` 執行。

- 工具:`skill_list`、`skill_read`(低風險);`skill_write`、`skill_delete`(中風險,權限節點 `skills.use`)。
- 設定 `[modules.skills]`:`max_skills = 50`、`max_body_chars = 6000`、`max_description_chars = 140`、`read_chars = 700`、`index_chars = 1500`。
- 整合:agent 應把 `SkillStore.index()`(服務 `SkillStoreKey`)放進提示詞。
