-- 保留 ec2-power-console 原有的 TARGETS 管理清單；若使用者已手動加入，
-- UNIQUE 約束會避免重複資料。
INSERT OR IGNORE INTO machines (region, instance_id, name, is_wavelength)
VALUES ('us-west-2', 'i-0d50f2b47b60208cb', 'SEA-1', 0);
