-- One-time transactional migration. Preserve the legacy public column names,
-- but align FTS rowids with blocks so updates/deletes use an indexed lookup.
BEGIN;
DROP TABLE blocks_fts;
CREATE VIRTUAL TABLE blocks_fts USING fts5(text, block_id UNINDEXED, paper_id UNINDEXED, page UNINDEXED, tokenize='unicode61');
INSERT INTO blocks_fts(rowid,text,block_id,paper_id,page) SELECT rowid,text,id,paper_id,page FROM blocks;
CREATE TRIGGER blocks_fts_insert_v2 AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid,text,block_id,paper_id,page) VALUES(new.rowid,new.text,new.id,new.paper_id,new.page);
END;
CREATE TRIGGER blocks_fts_delete_v2 AFTER DELETE ON blocks BEGIN
  DELETE FROM blocks_fts WHERE rowid=old.rowid;
END;
CREATE TRIGGER blocks_fts_update_v2 AFTER UPDATE ON blocks BEGIN
  DELETE FROM blocks_fts WHERE rowid=old.rowid;
  INSERT INTO blocks_fts(rowid,text,block_id,paper_id,page) VALUES(new.rowid,new.text,new.id,new.paper_id,new.page);
END;
COMMIT;
