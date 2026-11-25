-- Rollback for 0001_circles.sql. Deletes all circle, star and Starlight data.
DROP TABLE IF EXISTS c_stars;
DROP TABLE IF EXISTS c_light;
DROP TABLE IF EXISTS c_messages;
DROP TABLE IF EXISTS c_invites;
DROP TABLE IF EXISTS c_knocks;
DROP TABLE IF EXISTS c_ever;
DROP TABLE IF EXISTS c_members;
DROP TABLE IF EXISTS c_circles;
