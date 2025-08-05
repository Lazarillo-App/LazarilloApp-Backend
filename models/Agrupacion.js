const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const Agrupacion = sequelize.define("agrupaciones", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  nombre: {
    type: DataTypes.STRING,
    allowNull: false
  }
}, {
  timestamps: false
});

module.exports = Agrupacion;