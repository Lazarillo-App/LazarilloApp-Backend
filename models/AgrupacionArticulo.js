const { DataTypes } = require("sequelize");
const sequelize = require("../config/db");

const AgrupacionArticulo = sequelize.define("agrupacion_articulos", {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  agrupacion_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  articulo_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
}, {
  timestamps: false
});

module.exports = AgrupacionArticulo;